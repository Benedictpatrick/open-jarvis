import { tool } from 'ai';
import { z } from 'zod';
import { Sandbox } from '@vercel/sandbox';

export const codeExecTool = tool({
  description:
    'Run a short JavaScript or Python snippet in an isolated sandbox and return stdout/stderr. Use this for math, data processing, or any task better solved by executing code than reasoning about it.',
  inputSchema: z.object({
    language: z.enum(['javascript', 'python']),
    code: z.string().describe('The full source code to execute'),
  }),
  execute: async ({ language, code }) => {
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await Sandbox.create({
        runtime: language === 'python' ? 'python3.13' : 'node24',
        timeout: 30_000,
      });

      const filename = language === 'python' ? 'main.py' : 'main.js';
      await sandbox.writeFiles([{ path: filename, content: Buffer.from(code) }]);

      const result = await sandbox.runCommand({
        cmd: language === 'python' ? 'python3' : 'node',
        args: [filename],
      });

      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return { exitCode: result.exitCode, stdout, stderr };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      await sandbox?.stop();
    }
  },
});
