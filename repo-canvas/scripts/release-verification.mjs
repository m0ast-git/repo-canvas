import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile);
const repository="m0ast-git/repo-canvas";

export function attestationArguments(file,version) {
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error("Некорректная версия релиза");
  return ["attestation","verify",file,"--repo",repository,"--signer-workflow",`${repository}/.github/workflows/release.yml`,"--source-ref",`refs/tags/v${version}`,"--deny-self-hosted-runners","--format","json"];
}

export async function verifyReleaseAttestation(file,version,{execute=run}={}) {
  try {
    const result=await execute("gh",attestationArguments(file,version),{windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
    const verified=JSON.parse(result.stdout);if(!Array.isArray(verified)||!verified.length)throw new Error("Нет подтверждённой подписи");
    return {verified:true,repository,version};
  } catch(error) {
    if(error.code==="ENOENT")throw new Error("Для проверки подписи обновления нужен GitHub CLI (gh). Текущая версия сохранена; установите gh и повторите обновление.");
    throw new Error("Подпись и происхождение релиза не подтверждены. Текущая версия сохранена; автоматическая установка остановлена.");
  }
}
