import { SERVICE_CONFIG as S } from './config.js';
import type { LoopConfig } from './settings.js';

export const SERVICE_TARGETS = S.targets;
export type ServiceTarget = (typeof S.targets)[number];

const needsQuote = /[\s"'\\%]/;

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const systemdQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A user-level service definition (systemd user unit / launchd agent) running the loop against the
 * resolved `configPath`. Pure text: nothing is written anywhere.
 */
export function renderService(
  target: ServiceTarget,
  configPath: string,
  config: LoopConfig,
  /** Absolute path of the running CLI; a unit's ExecStart is not looked up on PATH. */
  cliPath: string,
): string {
  if (target === 'linux') {
    return [
      '# ~/.config/systemd/user/mandrel-loop.service',
      '[Unit]',
      `Description=${S.linux.unitDescription} (${config.mandrel.project})`,
      '',
      '[Service]',
      `ExecStart=${needsQuote.test(cliPath) ? systemdQuote(cliPath) : cliPath} ${S.subcommand} --config ${systemdQuote(configPath)}`,
      `EnvironmentFile=-${S.linux.environmentFile}`,
      'Restart=on-failure',
      `RestartSec=${S.linux.restartSec}`,
      '',
      '[Install]',
      `WantedBy=${S.linux.wantedBy}`,
      '',
    ].join('\n');
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- ~/Library/LaunchAgents/' + S.macos.label + '.plist -->',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${S.macos.label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${xml(`exec ${needsQuote.test(cliPath) ? shQuote(cliPath) : cliPath} ${S.subcommand} --config ${shQuote(configPath)}`)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${S.macos.logPath}</string>`,
    `  <key>StandardErrorPath</key><string>${S.macos.logPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
