import * as fs from 'fs';

/** Function values captured before Node's shared filesystem surfaces mutate. */
export function capturePhysicalFs() {
  return {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    rmSync: fs.rmSync,
    realpathSync: fs.realpathSync,
    watch: fs.watch,
  };
}

export type PhysicalFs = ReturnType<typeof capturePhysicalFs>;
