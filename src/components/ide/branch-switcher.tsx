import { Check, ChevronDown, GitBranch, Plus, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitBranches } from "@/hooks/use-project-git-branches";
import { cn } from "@/lib/utils";
import { useIdeStore } from "./ide-store";

const normalizeBranchName = (value: string) => value.trim();

const matchesBranchName = (left: string, right: string) =>
  normalizeBranchName(left).localeCompare(
    normalizeBranchName(right),
    undefined,
    {
      sensitivity: "accent",
    },
  ) === 0;

interface BranchSwitcherProps {
  onCreateWorktree?: () => void;
  projectId: string;
  projectPath: string;
}

const BranchSwitcherImpl = ({
  onCreateWorktree,
  projectId,
  projectPath,
}: BranchSwitcherProps) => {
  const branchT = useTranslations("branches");
  const commonT = useTranslations("common");
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const {
    branches,
    checkoutBranch,
    clearError,
    currentBranch,
    error,
    isRepo,
    loading,
    refresh,
    switching,
  } = useProjectGitBranches(projectPath, gitRefreshKey);

  const [open, setOpen] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [createBranchName, setCreateBranchName] = useState("");
  const normalizedSearchValue = normalizeBranchName(searchValue);
  const normalizedCreateBranchName = normalizeBranchName(createBranchName);

  const createBranchAlreadyExists = useMemo(
    () =>
      branches.some((branch) =>
        matchesBranchName(branch.name, normalizedCreateBranchName),
      ),
    [branches, normalizedCreateBranchName],
  );

  const canSubmitCreateBranch =
    normalizedCreateBranchName.length > 0 &&
    !createBranchAlreadyExists &&
    !loading &&
    !switching;

  useEffect(() => {
    if (open) {
      return;
    }

    clearError();
    setSearchValue("");
  }, [clearError, open]);

  useEffect(() => {
    if (createBranchOpen) {
      return;
    }

    setCreateBranchName("");
  }, [createBranchOpen]);

  const handleCheckout = useCallback(
    async (branchName: string, create = false) => {
      const normalizedBranchName = normalizeBranchName(branchName);
      if (!normalizedBranchName) {
        return;
      }

      if (
        !create &&
        matchesBranchName(normalizedBranchName, currentBranch ?? "")
      ) {
        setOpen(false);
        return;
      }

      await checkoutBranch(normalizedBranchName, create);
      bumpProjectGitRefreshKey(projectId);
      setOpen(false);
      setSearchValue("");
    },
    [bumpProjectGitRefreshKey, checkoutBranch, currentBranch, projectId],
  );

  const handleOpenCreateDialog = useCallback(() => {
    clearError();
    setOpen(false);
    setCreateBranchName("");
    setCreateBranchOpen(true);
  }, [clearError]);

  const handleCreateBranch = useCallback(async () => {
    if (!canSubmitCreateBranch) {
      return;
    }

    try {
      await handleCheckout(normalizedCreateBranchName, true);
      setCreateBranchOpen(false);
      setCreateBranchName("");
    } catch {
      // checkoutBranch stores the displayable error in hook state.
    }
  }, [canSubmitCreateBranch, handleCheckout, normalizedCreateBranchName]);

  if (!isRepo && !loading) {
    return null;
  }

  return (
    <>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={branchT("switchBranch")}
              className="h-8 max-w-[220px] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={loading && !currentBranch}
              size="sm"
              variant="ghost"
            />
          }
        >
          {switching ? (
            <Spinner className="size-3.5" />
          ) : (
            <GitBranch className="size-3.5 shrink-0" />
          )}
          <span className="truncate">
            {currentBranch ?? branchT("branches")}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[360px] gap-0 overflow-hidden p-0"
          side="top"
          sideOffset={8}
        >
          <Command shouldFilter>
            <div className="flex items-center gap-1 px-1 pt-1">
              <div className="min-w-0 flex-1">
                <CommandInput
                  className="text-xs"
                  onValueChange={setSearchValue}
                  placeholder={branchT("searchBranches")}
                  value={searchValue}
                />
              </div>
              <Button
                aria-label={branchT("refreshBranches")}
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                disabled={loading || switching}
                onClick={() => {
                  void refresh();
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {loading ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RotateCw className="size-4" />
                )}
              </Button>
            </div>
            <CommandList className="max-h-[280px]">
              {loading && branches.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-sm">
                  <Spinner className="size-4" />
                </div>
              ) : null}

              {branches.length > 0 ? (
                <CommandGroup heading={branchT("branches")}>
                  {branches.map((branch) => (
                    <CommandItem
                      className="text-xs data-[selected=true]:bg-transparent data-[selected=true]:hover:bg-muted hover:bg-muted"
                      disabled={switching}
                      key={branch.name}
                      keywords={[
                        branch.current ? branchT("currentBranch") : "",
                      ]}
                      onSelect={() => {
                        void handleCheckout(branch.name);
                      }}
                      value={branch.name}
                    >
                      <GitBranch className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {branch.name}
                      </span>
                      <Check
                        className={cn(
                          "absolute right-2 size-3.5 text-foreground transition-opacity",
                          branch.current ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {!loading ? (
                <CommandEmpty>
                  {normalizedSearchValue
                    ? branchT("noMatchingBranches")
                    : branchT("noLocalBranches")}
                </CommandEmpty>
              ) : null}
            </CommandList>

            <CommandSeparator />

            <div className="flex flex-col gap-1 p-1">
              <button
                className={cn(
                  "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                  loading || switching
                    ? "cursor-not-allowed text-surface-400 dark:text-surface-500"
                    : "text-foreground hover:bg-muted",
                )}
                disabled={loading || switching}
                onClick={handleOpenCreateDialog}
                type="button"
              >
                <Plus className="size-3.5 shrink-0" />
                <span className="truncate">
                  {branchT("createAndCheckoutNewBranch")}
                </span>
              </button>

              {onCreateWorktree ? (
                <button
                  className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                  disabled={loading || switching}
                  onClick={() => {
                    clearError();
                    setOpen(false);
                    onCreateWorktree();
                  }}
                  type="button"
                >
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{branchT("newWorktree")}</span>
                </button>
              ) : null}
            </div>

            {error ? (
              <div className="border-t border-surface-200 dark:border-surface-800 px-3 py-2 text-destructive text-xs">
                {error}
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog onOpenChange={setCreateBranchOpen} open={createBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{branchT("newBranch")}</DialogTitle>
            <DialogDescription>
              {branchT("newBranchDescription")}
            </DialogDescription>
          </DialogHeader>

          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateBranch();
            }}
          >
            <div className="grid gap-2">
              <label className="font-medium text-sm" htmlFor="branch-name">
                {branchT("newBranchName")}
              </label>
              <Input
                autoFocus
                disabled={switching}
                id="branch-name"
                onChange={(event) => {
                  setCreateBranchName(event.target.value);
                }}
                placeholder="feature/my-branch"
                value={createBranchName}
              />
              {normalizedCreateBranchName && createBranchAlreadyExists ? (
                <div className="text-destructive text-xs">
                  {branchT("branchAlreadyExists")}
                </div>
              ) : null}
            </div>

            {error ? (
              <div className="text-destructive text-sm">{error}</div>
            ) : null}

            <DialogFooter>
              <Button
                disabled={switching}
                onClick={() => setCreateBranchOpen(false)}
                type="button"
                variant="ghost"
              >
                {commonT("cancel")}
              </Button>
              <Button disabled={!canSubmitCreateBranch} type="submit">
                {switching ? (
                  <>
                    <Spinner className="size-3.5" />
                    <span>{branchT("createAndCheckoutBranch")}</span>
                  </>
                ) : (
                  branchT("createAndCheckoutBranch")
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const BranchSwitcher = memo(BranchSwitcherImpl);
BranchSwitcher.displayName = "BranchSwitcher";
