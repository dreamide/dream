import { Check, ChevronDown, GitBranch, Plus, RefreshCw } from "lucide-react";
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
  projectId: string;
  projectPath: string;
}

const BranchSwitcherImpl = ({
  projectId,
  projectPath,
}: BranchSwitcherProps) => {
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const {
    branches,
    checkoutBranch,
    currentBranch,
    error,
    isRepo,
    loading,
    refresh,
    switching,
  } = useProjectGitBranches(projectPath, gitRefreshKey);

  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
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

    setCreateMode(false);
    setSearchValue("");
    setCreateBranchName("");
  }, [open]);

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

  const handleOpenCreateForm = useCallback(() => {
    setCreateMode(true);
    setCreateBranchName("");
  }, []);

  const handleCancelCreate = useCallback(() => {
    setCreateMode(false);
    setCreateBranchName("");
  }, []);

  const handleCreateBranch = useCallback(async () => {
    if (!canSubmitCreateBranch) {
      return;
    }

    await handleCheckout(normalizedCreateBranchName, true);
    setCreateMode(false);
    setCreateBranchName("");
  }, [canSubmitCreateBranch, handleCheckout, normalizedCreateBranchName]);

  if (!isRepo && !loading) {
    return null;
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label="Switch Git branch"
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
        <span className="truncate">{currentBranch ?? "Branches"}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[360px] gap-0 overflow-hidden p-0"
        side="top"
        sideOffset={8}
      >
        {createMode ? (
          <form
            className="flex flex-col gap-3 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateBranch();
            }}
          >
            <div className="space-y-2">
              <div className="text-sm font-medium">New branch name</div>
              <Input
                autoFocus
                disabled={switching}
                onChange={(event) => {
                  setCreateBranchName(event.target.value);
                }}
                placeholder="feature/my-branch"
                value={createBranchName}
              />
              {normalizedCreateBranchName && createBranchAlreadyExists ? (
                <div className="text-destructive text-xs">
                  A branch with that name already exists.
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button
                disabled={switching}
                onClick={handleCancelCreate}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={!canSubmitCreateBranch} type="submit">
                {switching ? (
                  <>
                    <Spinner className="size-3.5" />
                    <span>Create and checkout branch</span>
                  </>
                ) : (
                  "Create and checkout branch"
                )}
              </Button>
            </div>

            {error ? (
              <div className="text-destructive text-xs">{error}</div>
            ) : null}
          </form>
        ) : (
          <Command shouldFilter>
            <CommandInput
              onValueChange={setSearchValue}
              placeholder="Search branches"
              value={searchValue}
            />
            <CommandList className="max-h-[280px]">
              {loading && branches.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-sm">
                  <Spinner className="size-4" />
                  <span>Loading branches…</span>
                </div>
              ) : null}

              {branches.length > 0 ? (
                <CommandGroup heading="Branches">
                  {branches.map((branch) => (
                    <CommandItem
                      disabled={switching}
                      key={branch.name}
                      keywords={[branch.current ? "current" : ""]}
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
                    ? "No matching branches."
                    : "No local branches found."}
                </CommandEmpty>
              ) : null}
            </CommandList>

            <CommandSeparator />

            <div className="flex items-center gap-2 p-2">
              <button
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                  loading || switching
                    ? "cursor-not-allowed text-muted-foreground/50"
                    : "text-foreground hover:bg-muted",
                )}
                disabled={loading || switching}
                onClick={handleOpenCreateForm}
                type="button"
              >
                <Plus className="size-3.5 shrink-0" />
                <span className="truncate">
                  Create and checkout new branch...
                </span>
              </button>

              <Button
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
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
            </div>

            {error ? (
              <div className="border-t border-foreground/10 px-3 py-2 text-destructive text-xs">
                {error}
              </div>
            ) : null}
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
};

export const BranchSwitcher = memo(BranchSwitcherImpl);
BranchSwitcher.displayName = "BranchSwitcher";
