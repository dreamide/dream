import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";

export const slugifyWorktreeBranchName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "worktree";

export const WorktreeFields = ({
  autoFocus = false,
  baseRef,
  branchName,
  idPrefix,
  onBaseRefChange,
  onBranchNameChange,
}: {
  autoFocus?: boolean;
  baseRef: string;
  branchName: string;
  idPrefix: string;
  onBaseRefChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
}) => {
  const commonT = useTranslations("common");
  const worktreeT = useTranslations("worktrees");

  return (
    <>
      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor={`${idPrefix}-branch`}>
          {commonT("branch")}
        </label>
        <Input
          autoFocus={autoFocus}
          id={`${idPrefix}-branch`}
          onChange={(event) => onBranchNameChange(event.target.value)}
          placeholder="my-feature"
          value={branchName}
        />
      </div>

      <div className="grid gap-2">
        <label className="font-medium text-sm" htmlFor={`${idPrefix}-base`}>
          {worktreeT("baseRef")}
        </label>
        <Input
          id={`${idPrefix}-base`}
          onChange={(event) => onBaseRefChange(event.target.value)}
          placeholder="main"
          value={baseRef}
        />
      </div>
    </>
  );
};
