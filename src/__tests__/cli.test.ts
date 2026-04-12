import { exec } from 'child_process';
import { test, expect } from 'vitest';

test('CLI should show help without arguments', async () => {
	return new Promise((resolve) => {
		exec('npx tsx scripts/cli.ts', (error, stdout, stderr) => {
			// The help command often exits with a non-zero code, which is fine.
			// We just want to ensure the help text is printed to stdout or stderr.
			const output = stdout + stderr;
			expect(output).toContain('Usage: SilkStack-cli [options] [command]');
			resolve(undefined);
		});
	});
});