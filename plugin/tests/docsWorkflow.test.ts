import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

// Seam: `.github/workflows/docs.yml` is the public contract for the docs
// channel and for which job may write the repository. The channel cases
// below are the literals from issue 12, not recomputed from the script.

const WORKFLOW_PATH = path.resolve(__dirname, '../../.github/workflows/docs.yml');

const STABLE_URL = 'codes.sota-shimozono.com/obsidian-remote-ssh';
const DEV_URL = 'codes.sota-shimozono.com/obsidian-remote-ssh/dev';

type Step = {
  name: string | null;
  uses: string | null;
  run: string | null;
  env: Record<string, string>;
  if: string | null;
  with: Record<string, string>;
};

type Job = {
  id: string;
  permissions: Record<string, string> | null;
  steps: Step[];
};

type Workflow = {
  permissions: Record<string, string> | null;
  jobs: Job[];
};

function indentOf(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBlock(
  lines: string[],
  start: number,
  keyIndent: number,
): { value: string; next: number } {
  const collected: string[] = [];
  let i = start;
  let contentIndent: number | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      collected.push('');
      i++;
      continue;
    }
    if (indentOf(line) <= keyIndent) break;
    if (contentIndent === null) contentIndent = indentOf(line);
    collected.push(line.slice(contentIndent));
    i++;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return { value: collected.join('\n'), next: i };
}

function parseMapping(
  lines: string[],
  start: number,
  parentIndent: number,
): { map: Record<string, string>; next: number } {
  const map: Record<string, string> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) break;
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest === '|' || rest === '|-' || rest === '>') {
      const block = parseBlock(lines, i + 1, ind);
      map[key] = block.value;
      i = block.next;
      continue;
    }
    map[key] = unquote(rest);
    i++;
  }
  return { map, next: i };
}

function emptyStep(): Step {
  return { name: null, uses: null, run: null, env: {}, if: null, with: {} };
}

function assignScalar(step: Step, key: string, value: string): void {
  if (key === 'name') step.name = value;
  else if (key === 'uses') step.uses = value;
  else if (key === 'run') step.run = value;
  else if (key === 'if') step.if = value;
}

function parseStep(lines: string[], index: number): { step: Step; next: number } {
  const step = emptyStep();
  const dashIndent = indentOf(lines[index]);
  let i = index;
  let first = true;
  while (i < lines.length) {
    const line = lines[i];
    if (!first && line.trim() === '') {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (!first && ind <= dashIndent) break;
    if (!first && line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const body = first ? line.trim().replace(/^- /, '') : line.trim();
    first = false;
    const colon = body.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();
    if (rest === '|' || rest === '|-' || rest === '>') {
      const block = parseBlock(lines, i + 1, ind);
      assignScalar(step, key, block.value);
      i = block.next;
      continue;
    }
    if (rest === '') {
      const nested = parseMapping(lines, i + 1, ind);
      if (key === 'env') step.env = nested.map;
      else if (key === 'with') step.with = nested.map;
      i = nested.next;
      continue;
    }
    assignScalar(step, key, unquote(rest));
    i++;
  }
  return { step, next: i };
}

function parseSteps(
  lines: string[],
  start: number,
  stepsIndent: number,
): { steps: Step[]; next: number } {
  const steps: Step[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (indentOf(line) <= stepsIndent) break;
    if (line.trimStart().startsWith('- ')) {
      const parsed = parseStep(lines, i);
      steps.push(parsed.step);
      i = parsed.next;
      continue;
    }
    i++;
  }
  return { steps, next: i };
}

function parseJob(lines: string[], start: number, id: string): { job: Job; next: number } {
  const job: Job = { id, permissions: null, steps: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || (line.trim().startsWith('#') && indentOf(line) <= 2)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= 2) break;
    const trimmed = line.trim();
    if (trimmed === 'permissions:' || trimmed.startsWith('permissions:')) {
      const parsed = parseMapping(lines, i + 1, ind);
      job.permissions = parsed.map;
      i = parsed.next;
      continue;
    }
    if (trimmed === 'steps:') {
      const parsed = parseSteps(lines, i + 1, ind);
      job.steps = parsed.steps;
      i = parsed.next;
      continue;
    }
    if (trimmed.endsWith(':') && !trimmed.includes(': ')) {
      const keyIndent = ind;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') {
          i++;
          continue;
        }
        if (indentOf(next) <= keyIndent) break;
        i++;
      }
      continue;
    }
    i++;
  }
  return { job, next: i };
}

function parseWorkflow(text: string): Workflow {
  const lines = text.split(/\r?\n/);
  let permissions: Record<string, string> | null = null;
  const jobs: Job[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0 || line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line === 'permissions:') {
      const parsed = parseMapping(lines, i + 1, 0);
      permissions = parsed.map;
      i = parsed.next - 1;
      continue;
    }
    if (line === 'jobs:') {
      let j = i + 1;
      while (j < lines.length) {
        const jobLine = lines[j];
        if (jobLine.trim() === '' || jobLine.trim().startsWith('#')) {
          j++;
          continue;
        }
        if (indentOf(jobLine) === 0) break;
        const match = jobLine.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          j++;
          continue;
        }
        const parsed = parseJob(lines, j + 1, match[1]);
        jobs.push(parsed.job);
        j = parsed.next;
      }
      i = j - 1;
    }
  }
  return { permissions, jobs };
}

function contentsPermission(workflow: Workflow, job: Job): string | undefined {
  if (job.permissions) return job.permissions.contents;
  return workflow.permissions?.contents;
}

function loadWorkflow(): Workflow {
  const workflow = parseWorkflow(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  if (workflow.jobs.length === 0) {
    throw new Error(`parser found no jobs in ${WORKFLOW_PATH}`);
  }
  return workflow;
}

function resolveChannel(
  script: string,
  input: { event: string; ref: string; base: string },
): { channel: string; url: string; canaryExists: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-channel-'));
  const scriptPath = path.join(dir, 'resolve.sh');
  const envPath = path.join(dir, 'github.env');
  const canary = path.join(dir, 'canary');
  fs.writeFileSync(scriptPath, script);
  fs.writeFileSync(envPath, '');
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: os.homedir(),
        GITHUB_ENV: envPath,
        EVENT_NAME: input.event,
        REF_NAME: input.ref,
        BASE_REF: input.base,
        CANARY: canary,
      },
    });
    const values = Object.fromEntries(
      fs
        .readFileSync(envPath, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
    );
    return {
      channel: values.DOCS_CHANNEL ?? '',
      url: values.QUARTZ_BASE_URL ?? '',
      canaryExists: fs.existsSync(canary),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('docs workflow permissions', () => {
  const workflow = loadWorkflow();
  const build = workflow.jobs.find((job) =>
    job.steps.some((step) => step.name === 'Resolve docs channel'),
  );
  const deploy = workflow.jobs.find((job) =>
    job.steps.some((step) => step.uses?.includes('github-pages-deploy-action')),
  );

  it('checks out, resolves the channel, and builds with contents read', () => {
    expect(build, 'job that resolves the docs channel').toBeDefined();
    expect(build!.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(build!.steps.some((step) => step.run?.includes('quartz/bootstrap-cli.mjs build'))).toBe(
      true,
    );
    expect(contentsPermission(workflow, build!)).toBe('read');
    expect(build!.steps.some((step) => step.uses?.includes('github-pages-deploy-action'))).toBe(
      false,
    );
  });

  it('grants contents write only on the job that deploys to gh-pages', () => {
    expect(deploy, 'job that deploys the built site').toBeDefined();
    expect(deploy!.id).not.toBe(build!.id);
    expect(contentsPermission(workflow, deploy!)).toBe('write');
    expect(workflow.permissions?.contents).not.toBe('write');
    for (const job of workflow.jobs) {
      if (job.id === deploy!.id) continue;
      expect(contentsPermission(workflow, job)).not.toBe('write');
    }
  });

  it('deploys a push of main to the gh-pages root and a push of next under dev', () => {
    const deploys = deploy!.steps.filter((step) =>
      step.uses?.includes('github-pages-deploy-action'),
    );
    expect(deploys).toHaveLength(2);
    const stable = deploys.find((step) => step.with['target-folder'] === undefined);
    const dev = deploys.find((step) => step.with['target-folder'] !== undefined);
    expect(stable?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(stable?.with.folder).toBe('public');
    expect(stable?.with.branch).toBe('gh-pages');
    expect(stable?.with.clean).toBe('true');
    expect(stable?.with['clean-exclude']).toContain('dev/');
    expect(dev?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/next'");
    expect(dev?.with.folder).toBe('public');
    expect(dev?.with.branch).toBe('gh-pages');
    expect(dev?.with['target-folder']).toBe('dev');
    expect(dev?.with.clean).toBe('true');
  });

  it('hands the built public directory to the deploy job', () => {
    const upload = build!.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    const download = deploy!.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(upload?.with.path).toBe('public');
    expect(upload?.with['if-no-files-found']).toBe('error');
    expect(upload?.with['include-hidden-files']).toBe('true');
    expect(download?.with.path).toBe('public');
    expect(download?.with.name).toBe(upload?.with.name);
    const firstDeploy = deploy!.steps.findIndex((step) =>
      step.uses?.includes('github-pages-deploy-action'),
    );
    const checkoutAt = deploy!.steps.findIndex((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    const downloadAt = deploy!.steps.findIndex((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(checkoutAt).toBeGreaterThanOrEqual(0);
    expect(downloadAt).toBeGreaterThanOrEqual(0);
    expect(checkoutAt).toBeLessThan(firstDeploy);
    expect(downloadAt).toBeLessThan(firstDeploy);
  });
});

describe('Resolve docs channel', () => {
  const workflow = loadWorkflow();
  const step = workflow.jobs
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === 'Resolve docs channel');

  it('reads event, ref, and base from the environment instead of the script text', () => {
    expect(step?.run, 'Resolve docs channel run script').toBeTruthy();
    expect(step?.env.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(step?.env.REF_NAME).toBe('${{ github.ref_name }}');
    expect(step?.env.BASE_REF).toBe('${{ github.base_ref }}');
    expect(step?.run).toContain('"$EVENT_NAME"');
    expect(step?.run).toContain('"$REF_NAME"');
    expect(step?.run).toContain('"$BASE_REF"');
    expect(step?.run).not.toContain('${{');
  });

  it('selects stable for a push of main or a pull request whose base is main', () => {
    const script = step!.run!;
    expect(resolveChannel(script, { event: 'push', ref: 'main', base: '' })).toEqual({
      channel: 'stable',
      url: STABLE_URL,
      canaryExists: false,
    });
    expect(
      resolveChannel(script, { event: 'pull_request', ref: '12/merge', base: 'main' }),
    ).toEqual({
      channel: 'stable',
      url: STABLE_URL,
      canaryExists: false,
    });
  });

  it('selects dev for every other run', () => {
    const script = step!.run!;
    const cases = [
      { event: 'push', ref: 'next', base: '' },
      { event: 'pull_request', ref: '12/merge', base: 'next' },
      { event: 'pull_request', ref: '12/merge', base: 'feature' },
      { event: 'push', ref: 'main-evil', base: '' },
      { event: 'workflow_dispatch', ref: 'main', base: 'main' },
    ];
    for (const input of cases) {
      expect(resolveChannel(script, input), JSON.stringify(input)).toEqual({
        channel: 'dev',
        url: DEV_URL,
        canaryExists: false,
      });
    }
  });

  it('treats a ref that would break out of quotes as an ordinary dev ref', () => {
    const script = step!.run!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-channel-payload-'));
    const canary = path.join(dir, 'canary');
    try {
      const result = resolveChannel(script, {
        event: 'push',
        ref: `main"; touch ${canary}; echo "`,
        base: '',
      });
      expect(result.channel).toBe('dev');
      expect(result.url).toBe(DEV_URL);
      expect(fs.existsSync(canary)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
