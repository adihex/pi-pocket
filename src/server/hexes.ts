/**
 * Hexes: with `HEXES=1`, every session but PiP's runs in a hex, an Incus container of its own (`vm/hex-base.sh` in the
 * deployment). The server keeps the conversation, the database, and the owner's token; a hex gets only its worktree
 * and the project's git directory, with everything in it that makes git run a program (config, hooks, modules, info)
 * read-only, and other hexes' worktree entries read-only. Its tools reach it through a pi-env daemon (`incus exec …
 * pi-env`), and the server's own git commands in a hex run there too (`git.ts`), so nothing a hex writes (a `.git`
 * pointer, a config, a filter) ever runs as the server or in another hex. Without `HEXES=1` nothing here is on.
 */
import { execFile } from "node:child_process";
import { access, constants, mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";

/** The container every hex is copied from (copy-on-write). */
const BASE = "hex-base";
/** The agent's user inside a hex; mounted files appear owned by it (`shift=true`). */
const HEX_USER = "1000";
const DAEMON = "/usr/local/bin/pi-env";
const SETUP_TIMEOUT_MS = 15 * 60_000;
const HEX_ENV = [
    "HOME=/home/hex",
    "USER=hex",
    "LOGNAME=hex",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
];

/** The worktrees folder while hexes are on; undefined: off. */
let root: string | undefined;
/** Hexes whose containers exist. */
const known = new Set<string>();
let log: (message: string) => void = () => undefined;

type Ran = { stdout: string; stderr: string };
type RunError = Error & { code?: unknown; stdout?: string; stderr?: string };

function run(file: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<Ran> {
    const { promise, resolve: done, reject: fail } = Promise.withResolvers<Ran>();

    execFile(
        file,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
            if (error === null) {
                done({ stdout, stderr });
            } else {
                fail(
                    Object.assign(new Error(stderr.trim() || error.message), {
                        code: error.code,
                        stdout,
                        stderr,
                    }) as RunError,
                );
            }
        },
    );

    return promise;
}

/** Turn hexes on for worktrees under `worktrees`, learning the hexes that exist already. */
export async function startHexes(worktrees: string, logger: (message: string) => void): Promise<void> {
    log = logger;
    const { stdout } = await run("incus", ["list", "--format", "csv", "--columns", "n"]);

    for (const name of stdout.split("\n").map((line) => line.trim())) {
        if (name.startsWith("hex-") && name !== BASE) {
            known.add(name);
        }
    }

    root = resolve(worktrees);
    log(`hexes on: ${known.size} hex(es) under ${root}`);
}

export function hexesOn(): boolean {
    return root !== undefined;
}

/** The worktree folder a path is in, when that is a hex's: one folder under the hexes' worktrees folder. */
export function hexWorktree(path: string): string | undefined {
    if (root === undefined) {
        return undefined;
    }

    const inside = relative(root, resolve(path));

    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        return undefined;
    }

    return join(root, inside.split(sep)[0]!);
}

/** The container of a worktree folder: `hex-` and the folder's name, as Incus allows (at most 63 characters). */
export function hexName(worktree: string): string {
    const slug = basename(worktree)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    return `hex-${slug.slice(-59)}`.replace(/-+$/, "");
}

/** The hex a path is in, once its container exists. */
export function hexOf(path: string): string | undefined {
    const worktree = hexWorktree(path);

    if (worktree === undefined) {
        return undefined;
    }

    const name = hexName(worktree);

    return known.has(name) ? name : undefined;
}

/** `incus exec` arguments that run `argv` in a hex as its agent user, in `cwd`, with `env` added. */
export function hexCommand(
    name: string,
    cwd: string,
    argv: readonly string[],
    env: Record<string, string> = {},
): string[] {
    const vars = [...HEX_ENV, ...Object.entries(env).map(([key, value]) => `${key}=${value}`)];

    return [
        "exec",
        name,
        "-T",
        "--user",
        HEX_USER,
        "--group",
        HEX_USER,
        "--cwd",
        cwd,
        ...vars.flatMap((variable) => ["--env", variable]),
        "--",
        ...argv,
    ];
}

/** Where a session in a hex runs its tools: a pi-env daemon inside the hex. */
export function hexEnv(name: string, cwd: string): RemoteExecutionEnv {
    const connection = new Connection({
        command: ["incus", ...hexCommand(name, cwd, [DAEMON])],
        onLog: (text) => log(`${name}: ${text.trim()}`),
    });

    return new RemoteExecutionEnv({ connection, id: `pi-env:${name}`, cwd });
}

/**
 * Make the hex for a new worktree: a copy of the base with the worktree and the git it writes mounted at their own
 * paths, started. The git paths come from the server's git in the worktree it just made, before the hex exists.
 */
export async function hexStatus(name: string): Promise<"running" | "suspended" | "stopped" | "absent"> {
    try {
        const { stdout } = await run("incus", ["info", name]);
        const match = stdout.match(/^Status:\s+(\w+)/m);
        if (!match || !match[1]) return "absent";
        const status = match[1].toUpperCase();
        if (status === "RUNNING") return "running";
        if (status === "FROZEN") return "suspended";
        if (status === "STOPPED") return "stopped";
        return "stopped";
    } catch {
        return "absent";
    }
}

export async function suspendHex(worktree: string): Promise<void> {
    const name = hexName(worktree);
    if (!known.has(name)) throw new HttpError(404, `No hex container for ${worktree}`);
    await run("incus", ["pause", name]);
    log(`hex ${name} suspended`);
}

export async function wakeHex(worktree: string): Promise<void> {
    const name = hexName(worktree);
    if (!known.has(name)) return;
    const status = await hexStatus(name);
    if (status === "suspended") {
        await run("incus", ["start", name]);
        log(`hex ${name} resumed`);
    } else if (status === "stopped") {
        await run("incus", ["start", name]);
        log(`hex ${name} started`);
    }
}

export async function createHex(worktree: string, sourceName?: string): Promise<string> {
    const name = hexName(worktree);
    const gitDir = (await run("git", ["rev-parse", "--absolute-git-dir"], worktree)).stdout.trim();
    const common = resolve(
        worktree,
        (await run("git", ["rev-parse", "--git-common-dir"], worktree)).stdout.trim(),
    );

    // Mount points for the read-only parts, which a repository may not have yet.
    for (const folder of ["hooks", "info", "modules", "worktrees"]) {
        await mkdir(join(common, folder), { recursive: true });
    }

    const fromSource = sourceName !== undefined && known.has(sourceName);
    const base = fromSource ? sourceName : BASE;
    await run("incus", ["copy", base, name]);

    if (fromSource) {
        for (const device of ["work", "git-worktree", "git", "git-config", "git-hooks", "git-info", "git-modules", "git-worktrees"]) {
            await run("incus", ["config", "device", "remove", name, device]).catch(() => {});
        }
    }
    const disk = (device: string, source: string, readonly: boolean) =>
        run("incus", [
            "config",
            "device",
            "add",
            name,
            device,
            "disk",
            `source=${source}`,
            `path=${source}`,
            "shift=true",
            ...(readonly ? ["readonly=true"] : []),
        ]);

    await disk("work", worktree, false);
    // The project's git directory, writable so every git command works (commits, packed refs, fetches)...
    await disk("git", common, false);
    // ...but what makes git run a program read-only: the hex cannot plant a config, hook, or submodule config for
    // the server's git in the project (or its own `git config`) to run.
    await disk("git-config", join(common, "config"), true);
    await disk("git-hooks", join(common, "hooks"), true);
    await disk("git-info", join(common, "info"), true);
    await disk("git-modules", join(common, "modules"), true);
    // Other hexes' worktree entries read-only (a hex could otherwise point another's `commondir` at a config it
    // wrote, and run code in that hex); its own writable.
    await disk("git-worktrees", join(common, "worktrees"), true);
    await disk("git-worktree", gitDir, false);
    await run("incus", ["start", name]);

    // Wait for the hex to finish booting before anything runs in it: its /tmp is a tmpfs mounted during boot (files
    // written before it would vanish under it), and setup may need the network. Right after `start`, systemd may not
    // answer yet ("Failed to connect to system scope bus"), so ask again until it says. "degraded" still means
    // booted, and exits non-zero, so the answer is read rather than the exit code.
    let booted = "";

    for (const until = Date.now() + 60_000; Date.now() < until; await sleep(250)) {
        booted = await run("incus", ["exec", name, "--", "systemctl", "is-system-running", "--wait"], undefined, 60_000)
            .then(({ stdout }) => stdout.trim(), (error: RunError) => (error.stdout ?? "").trim() || error.message);

        if (booted === "running" || booted === "degraded") {
            break;
        }
    }

    if (booted !== "running" && booted !== "degraded") {
        throw new Error(`hex ${name} did not finish booting: ${booted}`);
    }

    known.add(name);
    log(`hex ${name} made for ${worktree}`);

    return name;
}

/**
 * Run the repository's own preparation, `.agents/setup` (Amp's convention), inside the hex, from the worktree. Its
 * failure is the hex's: the caller discards the hex, and no prompt is sent to it.
 */
export async function setupHex(name: string, worktree: string): Promise<void> {
    try {
        await access(join(worktree, ".agents", "setup"), constants.X_OK);
    } catch {
        return;
    }

    try {
        await run("incus", hexCommand(name, worktree, ["./.agents/setup"]), undefined, SETUP_TIMEOUT_MS);
    } catch (error) {
        const failed = error as RunError;
        const said =
            `${failed.stderr ?? ""}${failed.stdout ?? ""}`.trim().slice(-800) || failed.message;
        const how = typeof failed.code === "number" ? ` (exit ${failed.code})` : "";

        throw new HttpError(422, `.agents/setup failed${how}: ${said}`);
    }
}

/** Remove a hex: its container, then its worktree folder by the path the server made, never by what the hex wrote. */
export async function removeHex(worktree: string): Promise<void> {
    const name = hexName(worktree);

    try {
        await run("incus", ["delete", "--force", name]);
    } catch (error) {
        if (!/not found/i.test((error as Error).message)) {
            throw error;
        }
    }

    known.delete(name);
    await rm(worktree, { recursive: true, force: true });
    log(`hex ${name} removed`);
}
