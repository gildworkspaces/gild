import { CloneView } from '../../packages/presentation/Headers'
export function CloneButton({ owner, repo }: { owner: string; repo: string }) {
  return <CloneView owner={owner} repo={repo} />
}
