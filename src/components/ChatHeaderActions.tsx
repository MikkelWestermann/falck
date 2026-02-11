import { ClockIcon, HistoryIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAIChat } from "@/contexts/AIChatContext";

export function ChatHeaderActions() {
  const {
    currentSession,
    creatingSession,
    loadingSession,
    createSession,
    selectSession,
    deleteSession,
    sortedSessions,
    formatSessionTime,
    historyOpen,
    setHistoryOpen,
  } = useAIChat();

  return (
    <div className="flex items-center gap-2">
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <HistoryIcon className="h-4 w-4" />
            Chats
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader className="border-b border-border/60 px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <DialogTitle>Session history</DialogTitle>
                <DialogDescription>
                  Pick up where you left off or start a fresh thread.
                </DialogDescription>
              </div>
              <Button
                onClick={() => createSession({ closeHistory: true })}
                disabled={creatingSession}
                size="sm"
                className="gap-2"
              >
                <PlusIcon className="size-4" />
                {creatingSession ? "Creating..." : "New chat"}
              </Button>
            </div>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-6 py-5">
            {sortedSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 bg-card/80 px-4 py-8 text-center text-sm text-muted-foreground">
                No sessions yet. Start a new one to build your history.
              </div>
            ) : (
              sortedSessions.map((session) => (
                <div
                  key={session.path}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/85 px-4 py-3 shadow-[var(--shadow-xs)] transition hover:-translate-y-[1px] hover:shadow-[var(--shadow-sm)]",
                    currentSession?.path === session.path
                      ? "border-primary/40 bg-secondary/40"
                      : "",
                  )}
                >
                  <button
                    className="flex-1 text-left disabled:pointer-events-none disabled:opacity-60"
                    onClick={() =>
                      selectSession(session, { closeHistory: true })
                    }
                    disabled={loadingSession}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {session.name}
                      </span>
                      {currentSession?.path === session.path && (
                        <Badge
                          variant="secondary"
                          className="rounded-full px-2 py-0 text-[0.6rem]"
                        >
                          Active
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ClockIcon className="size-3" />
                      <span>{formatSessionTime(session.created)}</span>
                      <span className="text-muted-foreground/60">•</span>
                      <span className="font-mono text-[0.7rem]">
                        {session.model}
                      </span>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteSession(session)}
                    disabled={loadingSession}
                  >
                    Delete
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Button
        onClick={() => createSession()}
        disabled={creatingSession}
        variant="outline"
        size="sm"
        className="gap-2"
      >
        <PlusIcon className="h-4 w-4" />
        {creatingSession ? "Creating..." : "New chat"}
      </Button>
    </div>
  );
}
