import { describe, expect, it } from 'vitest';
import { attribute, type Scope } from '../src/load/attribute.js';
import type { LiveProc } from '../src/load/procs.js';

const H = '/home/fleet';
const proc = (pid: number, ppid: number, over: Partial<LiveProc> = {}): LiveProc =>
  ({ pid, ppid, start: 0, cpuNs: 0, mem: 0, path: '/bin/x', args: 'x', ...over });
const scope = (over: Partial<Scope> = {}): Scope => ({ home: H, panes: new Map([['c_a', [10]]]), own: [], ...over });
const pids = (ps: LiveProc[] | undefined) => (ps ?? []).map((p) => p.pid).sort((a, b) => a - b);

describe('attribute', () => {
  it('gives a robot its pane tree', () => {
    const o = attribute([proc(10, 1), proc(11, 10), proc(12, 11), proc(13, 1)], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10, 11, 12]);
  });

  it('gives a robot its escaped server by its marks', () => {
    const o = attribute([proc(10, 1), proc(30, 1, { robot: 'c_a', home: H })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10, 30]);
  });

  it("keeps a dormant robot's escaped server", () => {
    const o = attribute([proc(31, 1, { robot: 'c_z', home: H })], scope({ panes: new Map([['c_z', []]]) }));
    expect(pids(o.robots.get('c_z'))).toEqual([31]);
  });

  it("leaves a deleted robot's leftovers out", () => {
    const o = attribute([proc(33, 1, { robot: 'c_gone', home: H })], scope());
    expect([...o.robots.values()].flat()).toEqual([]);
    expect(o.app).toEqual([]);
    expect(o.codex).toEqual([]);
  });

  it("leaves another fleet's robot alone", () => {
    const o = attribute([proc(32, 1, { robot: 'c_a', home: '/other' })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([]);
  });

  it('skips apps and what runs inside them', () => {
    const o = attribute([
      proc(40, 1, { path: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', robot: 'c_a', home: H }),
      proc(41, 40, { path: '/bin/zsh', robot: 'c_a', home: H }),
    ], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([]);
  });

  it("counts a framework's Python, whose binary sits in an app inside the framework", () => {
    const python = '/opt/homebrew/Cellar/python@3.15/3.15.0/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python';
    const o = attribute([proc(10, 1), proc(34, 1, { path: python, robot: 'c_a', home: H })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10, 34]);
  });

  it("skips what runs inside an app's own framework", () => {
    const helper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper';
    const o = attribute([proc(44, 1, { path: helper, robot: 'c_a', home: H })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([]);
  });

  it('survives a ppid cycle while looking for an app', () => {
    const o = attribute([proc(42, 43, { robot: 'c_a', home: H }), proc(43, 42)], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([42]);
  });

  it('keeps an app child in the pane tree', () => {
    const o = attribute([proc(10, 1), proc(11, 10), proc(14, 11, { path: '/x/Chromium.app/Contents/MacOS/Chromium' })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10, 11, 14]);
  });

  it('gives the shared codex server and its children to codex', () => {
    const o = attribute([
      proc(10, 1), proc(11, 10),
      proc(50, 11, { args: 'codex app-server --managed-daemon' }), proc(51, 50),
    ], scope());
    expect(pids(o.codex)).toEqual([50, 51]);
    expect(pids(o.robots.get('c_a'))).toEqual([10, 11]);
  });

  it("gives no robot what a session on codex's shared server starts, which carries the marks of the robot that started it", () => {
    const escaped = proc(52, 1, { robot: 'c_a', home: H });
    const o = attribute([proc(10, 1), proc(50, 1, { args: 'codex app-server --managed-daemon', robot: 'c_a', home: H }), escaped], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10]);
    expect(pids(attribute([proc(10, 1), escaped], scope()).robots.get('c_a'))).toEqual([10, 52]);
  });

  it('gives no robot what svalld, the tmux server or the app run, whatever their marks', () => {
    const marked = { robot: 'c_a', home: H };
    const o = attribute([
      proc(10, 20), proc(20, 1), proc(21, 20, marked), proc(22, 1), proc(23, 22, marked),
      proc(99, 1, { path: '/Applications/Svall.app/Contents/MacOS/Svall' }), proc(98, 99, marked),
    ], scope({ own: [20, 22], appPid: 99 }));
    expect(pids(o.robots.get('c_a'))).toEqual([10]);
    expect(pids(o.app)).toEqual([20, 21, 22, 23, 98, 99]);
  });

  it('gives WebKit to the app by responsibility, and the tmux server alone', () => {
    const o = attribute([
      proc(10, 1), proc(20, 1), proc(21, 20), proc(60, 1, { resp: 99 }), proc(99, 1),
    ], scope({ appPid: 99, own: [20] }));
    expect(pids(o.app)).toEqual([20, 21, 60, 99]);
  });

  it('keeps a pane shell under the tmux server with its robot', () => {
    const o = attribute([proc(20, 1), proc(10, 20)], scope({ own: [20] }));
    expect(pids(o.app)).toEqual([20]);
    expect(pids(o.robots.get('c_a'))).toEqual([10]);
  });

  it('copes with rows that have no args, cpu or memory', () => {
    const o = attribute([proc(10, 1, { args: '', cpuNs: 0, mem: 0 })], scope());
    expect(pids(o.robots.get('c_a'))).toEqual([10]);
  });
});
