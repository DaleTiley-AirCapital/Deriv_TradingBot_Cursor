import { useState, useRef, useEffect } from "react";
import { Bot, X, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getGetSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AiChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const base = import.meta.env.BASE_URL || "/";
      const resp = await fetch(`${base}api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updated.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Request failed" }));
        setMessages([...updated, { role: "assistant", content: err.error || "Something went wrong." }]);
        return;
      }

      const data = await resp.json();
      setMessages([...updated, { role: "assistant", content: data.reply }]);

      if (data.settingsChanged) {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      }
    } catch {
      setMessages([...updated, { role: "assistant", content: "Failed to connect to the AI service." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "fixed bottom-[84px] md:bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-all",
          "bg-primary text-primary-foreground hover:scale-105 active:scale-95",
          open && "bg-muted text-foreground"
        )}
      >
        {open ? <X className="w-5 h-5" /> : <Bot className="w-6 h-6" />}
      </button>

      {open && (
        <div className="fixed bottom-[156px] md:bottom-24 right-6 z-50 w-[380px] max-h-[520px] rounded-2xl border border-border/60 bg-[#1a2035] shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 bg-[#0e1120]">
            <Bot className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">AI Assistant</span>
            <span className="text-[10px] text-muted-foreground ml-auto">GPT-4o</span>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px] max-h-[360px]">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-xs py-8 space-y-2">
                <Bot className="w-8 h-8 mx-auto opacity-30" />
                <p>Ask me to change settings, explain strategies, or help with your trading configuration.</p>
                <div className="flex flex-wrap gap-1.5 justify-center mt-3">
                  {["Show my current settings", "Set trailing stop to 20%", "Explain composite scoring"].map(q => (
                    <button
                      key={q}
                      onClick={() => { setInput(q); }}
                      className="text-[10px] px-2 py-1 rounded-full border border-border/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-[#0e1120] text-foreground border border-border/30"
                )}>
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-[#0e1120] border border-border/30 rounded-xl px-3 py-2 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">Thinking...</span>
                </div>
              </div>
            )}
          </div>

          <div className="p-3 border-t border-border/30 bg-[#0e1120]">
            <form
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex items-center gap-2"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask anything..."
                className="flex-1 bg-[#1a2035] border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
                disabled={loading}
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="p-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-30 hover:bg-primary/90 transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
