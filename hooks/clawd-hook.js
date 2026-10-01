#!/usr/bin/env node
// Claude Code hook: forwards the current hook event to the Clawd desktop pet
// on 127.0.0.1. Only a few small fields are sent (event, tool name, a coarse
// shell-command kind) — never prompts, file contents or command text.
// Always exits 0 and prints nothing, so it can never block or alter Claude.

const http = require('http');

const PORT = Number(process.env.CLAWD_PORT) || 47321;

// Give up quickly if the pet isn't running or doesn't answer.
setTimeout(() => process.exit(0), 3000).unref();

function shellKind(command) {
  const c = command.trim().toLowerCase();
  if (/^(git|gh)\b/.test(c)) return 'git';
  if (/\b(test|tests|jest|vitest|pytest|mocha|playwright)\b/.test(c)) return 'test';
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add)\b|\bpip3?\s+install\b/.test(c)) return 'install';
  if (/\b(build|compile|make|tsc|webpack|vite|gradle|cargo|dotnet|electron-builder)\b/.test(c)) return 'build';
  return 'other';
}

function send(payload) {
  const body = JSON.stringify(payload);
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/event',
    method: 'POST',
    timeout: 1000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    res.resume();
    res.on('end', () => process.exit(0));
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => req.destroy());
  req.end(body);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    // Strip a UTF-8 BOM (Windows PowerShell adds one when piping).
    input = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    process.exit(0);
  }
  const payload = {
    event: input.hook_event_name,
    tool: input.tool_name,
    notification: input.notification_type,
  };
  const command = input.tool_input && input.tool_input.command;
  if (typeof command === 'string') payload.kind = shellKind(command);
  send(payload);
});
