import { useTranslations } from "next-intl";
import type {
  ProjectGitBranchDeleteBlock,
  ProjectGitBranchDeletePreview,
} from "@/types/ide";
import { InfoLine } from "./info-line";

/** The `branches` message that says why a branch cannot be deleted. */
export const branchDeleteBlockedKey = (reason: ProjectGitBranchDeleteBlock) =>
  (
    ({
      base: "blockedBase",
      current: "blockedCurrent",
      "main-checkout": "blockedMainCheckout",
    }) as const
  )[reason];

/**
 * The head to send with a delete. A merged branch needs none, so only a branch
 * that may hold unmerged work is deleted against what was shown for it.
 */
export const confirmedHeadFor = (
  preview: ProjectGitBranchDeletePreview | null,
) => (!preview || preview.unmergedCount === 0 ? null : preview.head);

/** What would be lost with a branch, shown before it is deleted. */
export const BranchDeleteSummary = ({
  preview,
}: {
  preview: ProjectGitBranchDeletePreview;
}) => {
  const branchT = useTranslations("branches");
  const { baseBranch, localOnlyCount, pullRequest, unmergedCount } = preview;
  const pullRequestValues = { number: String(pullRequest?.number ?? "") };

  return (
    <div className="space-y-1.5">
      {unmergedCount === 0 && baseBranch ? (
        <InfoLine>{branchT("mergedIntoBase", { base: baseBranch })}</InfoLine>
      ) : null}
      {unmergedCount !== null && unmergedCount > 0 && baseBranch ? (
        <InfoLine tone="warning">
          {branchT("unmergedCommits", {
            base: baseBranch,
            count: unmergedCount,
          })}
        </InfoLine>
      ) : null}
      {unmergedCount === null ? (
        <InfoLine tone="warning">{branchT("unmergedUnknown")}</InfoLine>
      ) : null}
      {pullRequest ? (
        <InfoLine>
          {pullRequest.state === "merged"
            ? branchT("pullRequestMerged", pullRequestValues)
            : pullRequest.state === "open"
              ? branchT("pullRequestOpen", pullRequestValues)
              : branchT("pullRequestClosed", pullRequestValues)}
        </InfoLine>
      ) : null}
      {localOnlyCount !== null && localOnlyCount > 0 ? (
        <InfoLine tone="warning">
          {branchT("localOnlyCommits", { count: localOnlyCount })}
        </InfoLine>
      ) : null}
      {localOnlyCount === 0 && unmergedCount !== 0 ? (
        <InfoLine>{branchT("commitsOnRemote")}</InfoLine>
      ) : null}
    </div>
  );
};
