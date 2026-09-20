import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { answerArtifact, gradeProviderTask } from './grading.js'

const run = promisify(execFile)

export async function verifyClampPatch(structured) {
  const grade = gradeProviderTask('clamp_patch', structured)
  if (!grade.all) return { passed: false, stage: 'grade', detail: grade.detail }
  const artifact = answerArtifact(structured).replace(/^```(?:diff)?\s*/i, '').replace(/\s*```$/, '')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'trencher-benchmark-'))
  try {
    await mkdir(path.join(temp, 'src'), { recursive: true })
    await writeFile(path.join(temp, 'package.json'), '{"type":"module"}\n')
    await writeFile(path.join(temp, 'src', 'clamp.js'), 'export function clamp(n, min, max) { return Math.min(min, Math.max(max, n)); }\n')
    await writeFile(path.join(temp, 'answer.patch'), `${artifact.trim()}\n`)
    await run('git', ['init', '--quiet'], { cwd: temp, windowsHide: true })
    await run('git', ['apply', '--check', 'answer.patch'], { cwd: temp, windowsHide: true })
    await run('git', ['apply', 'answer.patch'], { cwd: temp, windowsHide: true })
    await run(process.execPath, ['--input-type=module', '--eval', "const {clamp}=await import('./src/clamp.js');if(clamp(-2,0,10)!==0||clamp(5,0,10)!==5||clamp(12,0,10)!==10)process.exit(1)"], { cwd: temp, windowsHide: true })
    return { passed: true, stage: 'test', tests: 3 }
  } catch (error) {
    return { passed: false, stage: 'git-or-test', detail: String(error?.stderr || error?.message || error).slice(0, 1000) }
  } finally {
    if (temp.startsWith(path.resolve(os.tmpdir()))) await rm(temp, { recursive: true, force: true })
  }
}
