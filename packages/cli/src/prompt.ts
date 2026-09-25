import readline from 'node:readline';

export function ask(q: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.on('close', () => resolve(''));
    // close fires at once and resolves '', so the answer has to land first
    rl.question(q, (a) => { resolve(a); rl.close(); });
  });
}
