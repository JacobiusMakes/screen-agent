#!/usr/bin/env node

/**
 * WADE — Watchful Autonomous Decision Entity
 *
 * Your AI's eyes, hands, and instincts on macOS.
 * Operates using the WADE Protocol: Watch → Assess → Decide → Execute
 *
 * Commands:
 *   wade state          Capture current screen state
 *   wade ambient        Lightweight: app + title + cursor (~5 tokens)
 *   wade watch          Stream state changes continuously
 *   wade screenshot     Capture screenshot to file
 *   wade tokens         Estimate token cost of current state
 *   wade chat           Natural language REPL — talk to your screen
 */

import { Command } from 'commander';
import { captureState, captureAmbient, captureScreenshot, watchState } from '../src/capture/bridge.js';

const program = new Command();

program
  .name('wade')
  .description('WADE — Watchful Autonomous Decision Entity. Watch → Assess → Decide → Execute.')
  .version('0.2.0');

program
  .command('state')
  .description('WATCH — Capture current screen state (accessibility tree + cursor + focused app)')
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
  .description('WATCH (light) — App name + window title + cursor position (~5 tokens)')
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
  .description('WATCH (continuous) — Stream screen state changes')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--ambient-only', 'Only emit lightweight ambient states')
  .action(async (opts) => {
    const interval = parseInt(opts.interval);
    const ambientOnly = opts.ambientOnly;

    console.error(`[wade] Watching screen (${interval}ms interval)...`);
    console.error('[wade] Press Ctrl+C to stop.\n');

    for await (const state of watchState({ interval, ambientOnly })) {
      console.log(JSON.stringify(state));
    }
  });

program
  .command('screenshot')
  .description('WATCH (visual) — Capture screenshot and save to file')
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
  .description('ASSESS — Estimate token cost of current screen state')
  .action(async () => {
    const state = await captureState();
    if (!state) {
      console.error('Error: Could not capture state.');
      process.exit(1);
    }

    const json = JSON.stringify(state);
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

program
  .command('chat')
  .description('EXECUTE — Natural language REPL, talk to your screen with Claude')
  .option('--model <model>', 'Override Claude model', process.env.WADE_CHAT_MODEL || 'claude-sonnet-4-6')
  .option('--budget <preset>', 'Budget preset', process.env.WADE_BUDGET || 'normal')
  .action(async (opts) => {
    if (opts.model) process.env.SCREEN_AGENT_CHAT_MODEL = opts.model;
    if (opts.budget) process.env.SCREEN_AGENT_BUDGET = opts.budget;
    await import('./wade-chat.js');
  });

if (process.argv.length <= 2) {
  program.help();
}

program.parse();
