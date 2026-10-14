import type { ImportRecord } from '../api/import-contract.ts'
import { writeMeta } from '../metastore.ts'
import { applyImportBatch } from './apply.ts'
export async function writeImportBatch(owner:string,repo:string,by:string,records:ImportRecord[]) {
  return writeMeta(owner,repo,'Import source metadata',by,fs=>applyImportBatch(fs,records),{codeRefs:{},deferProjection:true,historical:true})
}
