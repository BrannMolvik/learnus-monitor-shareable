import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('desktop startup scans once and report reload does not request another scan', { skip: process.platform !== 'win32' }, () => {
  const viewer = fileURLToPath(new URL('../show-daily-brief.ps1', import.meta.url)).replaceAll("'", "''");
  const code = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $issues = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${viewer}', [ref]$tokens, [ref]$issues)
    if ($issues.Count) { throw 'Viewer syntax error.' }
    if (-not ($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'ScanOnOpen' })) { throw 'Missing startup switch.' }
    $empty = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if (-not $HasBrief -and -not $HasHistory') }, $true)
    if (-not $empty) { throw 'Missing empty-data guard.' }
    $condition = [scriptblock]::Create($empty.Clauses[0].Item1.Extent.Text)
    $HasBrief = $false; $HasHistory = $false; $script:ScanOnOpen = $true
    if (& $condition) { throw 'First launch must scan even without saved data.' }
    $script:ScanOnOpen = $false
    if (-not (& $condition)) { throw 'Plain viewer launch should keep the existing empty-data behavior.' }
    $startup = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($script:ScanOnOpen)') }, $true)
    if (-not $startup) { throw 'Missing startup action.' }
    function Start-UpdateScan { $script:calls++ }
    $script:calls = 0; $script:ScanOnOpen = $true
    $block = [scriptblock]::Create($startup.Extent.Text)
    & $block; & $block
    if ($script:calls -ne 1 -or $script:ScanOnOpen) { throw 'Startup action must be consumed once.' }
    $reload = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Restart-Viewer' }, $true)
    if (-not $reload -or $reload.Extent.Text -match '-ScanOnOpen') { throw 'Report reload must not request another scan.' }
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
});

test('shortcut installer is portable, idempotent and preserves unrelated shortcuts', { skip: process.platform !== 'win32' }, async () => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'learnus-shortcut-'));
  try {
    const install = path.join(root, 'Install With Spaces'), output = path.join(root, 'Shortcuts');
    await fs.mkdir(install);
    await fs.copyFile(new URL('../install-shortcuts.ps1', import.meta.url), path.join(install, 'install-shortcuts.ps1'));
    for (const file of ['show-daily-brief.ps1', 'run-lightweight-monitor.ps1']) await fs.writeFile(path.join(install, file), '# synthetic launcher fixture');
    const quote = value => value.replaceAll("'", "''");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    const run = code => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference='Stop'; " + code], { env, encoding: 'utf8', timeout: 30000 });
    const command = `& '${quote(path.join(install, 'install-shortcuts.ps1'))}' -Directory '${quote(output)}'`;
    for (let i = 0; i < 2; i++) { const result = run(command); assert.equal(result.status, 0, result.stdout + result.stderr); }
    const link = path.join(output, 'LearnUs Monitor.lnk');
    const inspect = run(`$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut('${quote(link)}'); @{Target=$link.TargetPath;Arguments=$link.Arguments;WorkingDirectory=$link.WorkingDirectory} | ConvertTo-Json -Compress`);
    assert.equal(inspect.status, 0, inspect.stderr);
    const shortcut = JSON.parse(inspect.stdout);
    assert.match(shortcut.Target, /WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.equal(shortcut.Arguments, `-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(install, 'show-daily-brief.ps1')}" -ScanOnOpen`);
    assert.equal(shortcut.WorkingDirectory, install);
    assert.doesNotMatch(shortcut.Arguments, /password|username|codex exec/i);
    const replace = run(`$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut('${quote(link)}'); $link.TargetPath=$env:ComSpec; $link.Arguments=''; $link.Save()`);
    assert.equal(replace.status, 0, replace.stderr);
    const before = await fs.readFile(link), refused = run(command);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Existing shortcut points elsewhere/);
    assert.deepEqual(await fs.readFile(link), before);
  } finally {
    assert.equal(path.dirname(root), tempRoot);
    await fs.rm(root, { recursive: true, force: true });
  }
});
