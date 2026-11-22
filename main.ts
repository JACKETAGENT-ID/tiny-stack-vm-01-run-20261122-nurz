import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
// Immediate length per opcode; -1 means unknown opcode.
function immLen(op: number): number {
  if (op === 0x01) return 1;
  if (op === 0x02) return 4;
  if (op >= 0x30 && op <= 0x33) return 2;
  const plain = op === 0 || (op >= 3 && op <= 7) || (op >= 0x10 && op <= 0x1e) ||
    (op >= 0x20 && op <= 0x22) || op === 0x34 || op === 0x40 || op === 0x41 ||
    (op >= 0x50 && op <= 0x53);
  return plain ? 0 : -1;
}
// [values popped, net stack growth] per opcode.
function stackNeed(op: number): [number, number] {
  switch (op) {
    case 0x01: case 0x02: case 0x52: return [0, 1];
    case 0x04: return [1, 1];
    case 0x06: return [2, 1];
    case 0x03: case 0x31: case 0x32: case 0x50: case 0x51: case 0x53: return [1, -1];
    case 0x05: case 0x07: return [op === 0x05 ? 2 : 3, 0];
    case 0x17: case 0x1b: case 0x40: return [1, 0];
    case 0x41: return [2, -2];
    default: return op >= 0x10 && op <= 0x22 ? [2, -1] : [0, 0];
  }
}

function run(prog: Buffer, input: Buffer): { out: number[]; code: number } {
  const stack: number[] = [];
  const calls: number[] = [];
  const mem: number[] = new Array(256).fill(0);
  const out: number[] = [];
  let pc = 0, steps = 0, inPos = 0;

  const fail = (code: number) => { throw { trap: code }; };
  const push = (v: number) => { stack.push(v | 0); };
  const pop = (): number => stack.pop() as number;
  const peek = (): number => stack[stack.length - 1];

  try {
    for (;;) {
      if (steps >= 1_000_000) fail(10);
      if (pc < 0 || pc >= prog.length) fail(9);
      const op = prog[pc];
      const ilen = immLen(op);
      if (ilen < 0) fail(5);
      if (pc + 1 + ilen > prog.length) fail(9);
      const immAt = pc + 1;
      const next = pc + 1 + ilen;
      const [pops, growth] = stackNeed(op);
      if (stack.length < pops) fail(2);
      if (stack.length + growth > 256) fail(3);
      steps++;

      switch (op) {
        case 0x00: return { out, code: 0 };
        case 0x01: { const b = prog[immAt]; push(b > 127 ? b - 256 : b); pc = next; break; }
        case 0x02:
          push(prog[immAt] | (prog[immAt + 1] << 8) | (prog[immAt + 2] << 16) | (prog[immAt + 3] << 24));
          pc = next; break;
        case 0x03: pop(); pc = next; break;
        case 0x04: push(peek()); pc = next; break;
        case 0x05: { const b = pop(), a = pop(); push(b); push(a); pc = next; break; }
        case 0x06: push(stack[stack.length - 2]); pc = next; break;
        case 0x07: { const c = pop(), b = pop(), a = pop(); push(b); push(c); push(a); pc = next; break; }
        case 0x10: { const b = pop(), a = pop(); push(a + b); pc = next; break; }
        case 0x11: { const b = pop(), a = pop(); push(a - b); pc = next; break; }
        case 0x12: { const b = pop(), a = pop(); push(Math.imul(a, b)); pc = next; break; }
        case 0x13: { const b = pop(), a = pop(); if (b === 0) fail(4); push(Math.trunc(a / b)); pc = next; break; }
        case 0x14: { const b = pop(), a = pop(); if (b === 0) fail(4); push(a % b); pc = next; break; }
        case 0x15: { const b = pop(), a = pop(); if (b === 0) fail(4); push(Math.trunc((a >>> 0) / (b >>> 0))); pc = next; break; }
        case 0x16: { const b = pop(), a = pop(); if (b === 0) fail(4); push((a >>> 0) % (b >>> 0)); pc = next; break; }
        case 0x17: push(-pop()); pc = next; break;
        case 0x18: { const b = pop(), a = pop(); push(a & b); pc = next; break; }
        case 0x19: { const b = pop(), a = pop(); push(a | b); pc = next; break; }
        case 0x1a: { const b = pop(), a = pop(); push(a ^ b); pc = next; break; }
        case 0x1b: push(~pop()); pc = next; break;
        case 0x1c: { const b = pop(), a = pop(); push(a << (b & 31)); pc = next; break; }
        case 0x1d: { const b = pop(), a = pop(); push(a >> (b & 31)); pc = next; break; }
        case 0x1e: { const b = pop(), a = pop(); push(a >>> (b & 31)); pc = next; break; }
        case 0x20: { const b = pop(), a = pop(); push(a === b ? 1 : 0); pc = next; break; }
        case 0x21: { const b = pop(), a = pop(); push(a < b ? 1 : 0); pc = next; break; }
        case 0x22: { const b = pop(), a = pop(); push((a >>> 0) < (b >>> 0) ? 1 : 0); pc = next; break; }
        case 0x30: case 0x31: case 0x32: {
          let off = prog[immAt] | (prog[immAt + 1] << 8);
          if (off >= 32768) off -= 65536;
          let go = op === 0x30;
          if (op === 0x31) go = pop() === 0;
          if (op === 0x32) go = pop() !== 0;
          pc = go ? next + off : next; break;
        }
        case 0x33: {
          if (calls.length >= 64) fail(7);
          calls.push(next);
          pc = prog[immAt] | (prog[immAt + 1] << 8); break;
        }
        case 0x34:
          if (calls.length === 0) fail(8);
          pc = calls.pop() as number; break;
        case 0x40: {
          const addr = pop();
          if (addr < 0 || addr > 255) fail(6);
          push(mem[addr]); pc = next; break;
        }
        case 0x41: {
          const addr = pop(), v = pop();
          if (addr < 0 || addr > 255) fail(6);
          mem[addr] = v; pc = next; break;
        }
        case 0x50: {
          const s = String(pop());
          if (out.length + s.length > 65536) fail(11);
          for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
          pc = next; break;
        }
        case 0x51: {
          const v = pop();
          if (out.length + 1 > 65536) fail(11);
          out.push(v & 255); pc = next; break;
        }
        case 0x52:
          push(inPos < input.length ? input[inPos++] : -1); pc = next; break;
        case 0x53: return { out, code: pop() & 255 };
        default: fail(5);
      }
    }
  } catch (e: any) {
    if (e && typeof e.trap === "number") return { out, code: e.trap };
    throw e;
  }
}

for (const ent of readdirSync(inDir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const id = ent.name;
  const prog = readFileSync(join(inDir, id, "program.bin"));
  let input: Buffer;
  try { input = readFileSync(join(inDir, id, "input.bin")); }
  catch { input = Buffer.alloc(0); }
  const { out, code } = run(prog, input);
  const dest = join(outDir, id);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "stdout.bin"), Buffer.from(out));
  writeFileSync(join(dest, "exit.txt"), String(code));
}
