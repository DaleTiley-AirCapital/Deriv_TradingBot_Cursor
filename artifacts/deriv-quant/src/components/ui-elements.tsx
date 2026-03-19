import React from "react";
import { cn } from "@/lib/utils";
import { Loader2, Info } from "lucide-react";

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("glass-panel rounded-xl overflow-hidden flex flex-col", className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-5 py-4 border-b border-border/50 flex flex-row items-center justify-between gap-3", className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold text-foreground flex items-center gap-2", className)} {...props}>
      {children}
    </h3>
  );
}

export function CardContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-5 flex-1", className)} {...props}>
      {children}
    </div>
  );
}

export function MetricValue({ 
  value, 
  label, 
  trend, 
  prefix = "", 
  suffix = "",
  mono = true,
  size = "default"
}: { 
  value: React.ReactNode; 
  label?: string; 
  trend?: "up" | "down" | "neutral";
  prefix?: string;
  suffix?: string;
  mono?: boolean;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
      )}
      <div className="flex items-baseline gap-0.5">
        <span className={cn(
          "font-bold tracking-tight",
          size === "sm" && "text-xl",
          size === "default" && "text-2xl lg:text-3xl",
          size === "lg" && "text-4xl",
          mono && "font-mono tabular-nums",
          !trend && "text-foreground",
          trend === "up" && "text-success",
          trend === "down" && "text-destructive",
          trend === "neutral" && "text-foreground"
        )}>
          {prefix}{value}{suffix}
        </span>
      </div>
    </div>
  );
}

export function Badge({ 
  children, 
  variant = "default",
  className 
}: { 
  children: React.ReactNode; 
  variant?: "default" | "success" | "destructive" | "warning" | "outline";
  className?: string;
}) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide leading-tight",
      variant === "default" && "bg-primary/15 text-primary border border-primary/25",
      variant === "success" && "bg-success/15 text-success border border-success/25",
      variant === "destructive" && "bg-destructive/15 text-destructive border border-destructive/25",
      variant === "warning" && "bg-warning/15 text-warning border border-warning/25",
      variant === "outline" && "border border-border/80 text-muted-foreground",
      className
    )}>
      {children}
    </span>
  );
}

export function Button({ 
  children, 
  variant = "default", 
  size = "md",
  isLoading = false,
  className,
  ...props 
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { 
  variant?: "default" | "primary" | "destructive" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-40 disabled:cursor-not-allowed select-none",
        size === "sm" && "px-3 py-1.5 text-xs gap-1.5",
        size === "md" && "px-4 py-2 text-sm gap-2",
        size === "lg" && "px-6 py-3 text-base gap-2",
        variant === "default" && "bg-secondary text-secondary-foreground hover:bg-secondary/70 border border-border/60",
        variant === "primary" && "bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90 hover:shadow-primary/40",
        variant === "destructive" && "bg-destructive text-destructive-foreground shadow-md shadow-destructive/25 hover:bg-destructive/90",
        variant === "outline" && "border border-border bg-transparent hover:bg-muted/50 text-foreground",
        variant === "ghost" && "hover:bg-muted text-muted-foreground hover:text-foreground",
        className
      )}
      disabled={props.disabled || isLoading}
      {...props}
    >
      {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-sans text-foreground ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        className
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "text-xs font-medium leading-none text-muted-foreground uppercase tracking-wide peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-9 w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground font-sans ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50 appearance-none transition-colors cursor-pointer",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("border-t border-border/50", className)} />;
}

export function InfoTooltip({ content, className }: { content: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative group inline-flex shrink-0", className)}>
      <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help hover:text-foreground transition-colors" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 w-60 p-3 rounded-lg bg-popover border border-border text-xs text-muted-foreground shadow-xl z-50 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-150 pointer-events-none leading-relaxed">
        {content}
        <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-border" />
      </div>
    </div>
  );
}

export function KpiCard({
  label,
  value,
  trend,
  prefix = "",
  suffix = "",
  detail,
  accentColor = "blue",
  icon,
  tooltip,
  className
}: {
  label: string;
  value: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  prefix?: string;
  suffix?: string;
  detail?: React.ReactNode;
  accentColor?: "blue" | "green" | "red" | "amber" | "purple";
  icon?: React.ReactNode;
  tooltip?: React.ReactNode;
  className?: string;
}) {
  const accentClass = {
    blue: "card-accent-blue",
    green: "card-accent-green",
    red: "card-accent-red",
    amber: "card-accent-amber",
    purple: "card-accent-purple",
  }[accentColor];

  const iconBgClass = {
    blue: "bg-primary/10 text-primary",
    green: "bg-success/10 text-success",
    red: "bg-destructive/10 text-destructive",
    amber: "bg-warning/10 text-warning",
    purple: "bg-purple-500/10 text-purple-400",
  }[accentColor];

  return (
    <div className={cn("glass-panel rounded-xl p-5 flex flex-col gap-3", accentClass, className)}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">{label}</span>
          {tooltip && <InfoTooltip content={tooltip} />}
        </div>
        {icon && (
          <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0", iconBgClass)}>
            {icon}
          </div>
        )}
      </div>
      <div className={cn(
        "text-2xl font-bold font-mono tabular-nums tracking-tight",
        trend === "up" && "text-success",
        trend === "down" && "text-destructive",
        (!trend || trend === "neutral") && "text-foreground"
      )}>
        {prefix}{value}{suffix}
      </div>
      {detail && (
        <div className="text-xs text-muted-foreground border-t border-border/40 pt-2.5 mt-auto">
          {detail}
        </div>
      )}
    </div>
  );
}
