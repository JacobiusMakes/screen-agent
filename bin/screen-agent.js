#!/usr/bin/env node

/**
 * screen-agent — AI screen understanding from the terminal
 *
 * Captures your screen state (accessibility tree, window info, cursor)
 * and outputs token-efficient JSON for LLM consumption.
 *
 * Commands:
 *   screen-agent state          One-shot: print current screen state
 *   screen-agent ambient        Lightweight: app name + title + cursor
 *   screen-agent watch          Continuous: stream state changes
 *   screen-agent screenshot     Capture screenshot, save to file
 *   screen-agent tokens         Estimate token count for current state
 *   screen-agent mcp            Start MCP server for Claude Code integration
 */

import { Command } from 'commander';
import { captureState, captureAmbient, captureScreenshot, watchState } from '../src/capture/bridge.js';

const program = new Command();

program
  .name('screen-agent')
  .description('AI screen understanding — capture screen state for LLM context')
  .version('0.1.0');

program
  .command('state')
  .description('Capture current screen state (accessibility tree + cursor + focused app)')
  .option('--pretty', 'Pretty-print JSON output')
  .option('--max-elements <n>', 'Max UI elements to extract', '60')
  .action(async (opts) => {
    const state = await captureState();
    if (!state) {
      console.error('Error: Could not capture screen state.');
      console.error('Make sure Accessibility permission is granted in System Settings.');
      process.exit(1);
    }
    console.log(opts.pretty ? JSON.stringify(state, null, 2) : JSON.stringify(state));
  });

program
  .command('ambient')
  .description('Lightweight state: app name + window title + cursor position (~5 tokens)')
  .action(async () => {
    const state = await captureAmbient();
    if (!state) {
      console.error('Error: Could not capture ambient state.');
      process.exit(1);
    }
    console.log(JSON.stringify(state));
  });

program
  .command('watch')
  .description('Stream screen state changes continuously')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--ambient-only', 'Only emit lightweight ambient states')
  .action(async (opts) => {
    const interval = parseInt(opts.interval);
    const ambientOnly = opts.ambientOnly;

    console.error(`[screen-agent] Watching screen (${interval}ms interval)...`);
    console.error('[screen-agent] Press Ctrl+C to stop.\n');

    for await (const state of watchState({ interval, ambientOnly })) {
      console.log(JSON.stringify(state));
    }
  });

program
  .command('screenshot')
  .description('Capture a screenshot and save to file')
  .option('-o, --output <path>', 'Output file path')
  .action(async (opts) => {
    const result = await captureScreenshot(opts.output);
    if (!result) {
      console.error('Error: Screenshot failed. Grant Screen Recording permission.');
      process.exit(1);
    }
    console.log(result);
  });

program
  .command('tokens')
  .description('Estimate token count for current screen state')
  .action(async () => {
    const state = await captureState();
    if (!state) {
      console.error('Error: Could not capture state.');
      process.exit(1);
    }

    const json = JSON.stringify(state);
    // Rough token estimate: ~4 chars per token for structured JSON
    const estimatedTokens = Math.ceil(json.length / 4);

    console.log(`Screen state size: ${json.length} chars`);
    console.log(`Estimated tokens: ~${estimatedTokens}`);
    console.log(`Elements extracted: ${state.elements?.length || 0}`);
    console.log(`Focused app: ${state.app}`);
    console.log(`Window: ${state.title}`);
    console.log('');
    console.log(`Cost estimate (Claude Sonnet @ $3/M input):`);
    console.log(`  Single capture: $${(estimatedTokens * 3 / 1000000).toFixed(6)}`);
    console.log(`  Per minute (30s interval): $${(estimatedTokens * 2 * 3 / 1000000).toFixed(6)}`);
    console.log(`  Per hour: $${(estimatedTokens * 120 * 3 / 1000000).toFixed(4)}`);
  });

if (process.argv.length <= 2) {
  program.help();
}

program.parse();
