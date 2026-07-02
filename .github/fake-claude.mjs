#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function log(message, data) {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.error(`[fake-claude] ${message}${suffix}`);
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

async function callFileOpsCommit() {
  const config = parseMcpConfig();
  const server = config.mcpServers?.github_file_ops;
  if (!server) throw new Error("github_file_ops server missing from MCP config");

  const markerPath = "e2e-action-marker.txt";
  const marker = [
    `intended branch: ${process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME}`,
    `run id: ${process.env.GITHUB_RUN_ID}`,
    `workspace: ${process.env.GITHUB_WORKSPACE}`,
    "",
  ].join("\n");
  writeFileSync(markerPath, marker);

  log("spawning mcp server", {
    command: server.command,
    args: server.args,
    branch: server.env?.BRANCH_NAME,
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
      clientInfo: { name: "fake-claude-e2e", version: "1.0.0" },
    },
  });
  await waitForResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "commit_files",
      arguments: {
        files: [markerPath],
        message: "poc: claude action e2e hash ref confusion",
      },
    },
  });
  const result = await waitForResponse(child, 2);
  log("commit_files result", result);
  child.stdin.end();
  child.kill("SIGTERM");
  return result;
}

let stdin = "";
let started = false;
process.stdin.on("data", (chunk) => {
  stdin += chunk.toString("utf8");
  scheduleStart();
});

process.stdin.on("end", () => {
  scheduleStart(0);
});

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
    const result = await callFileOpsCommit();
    console.log(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        tools: ["mcp__github_file_ops__commit_files"],
        model: "fake-claude",
      }),
    );
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
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
