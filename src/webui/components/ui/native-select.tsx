import { cn } from "cn";
import type * as React from "react";

// ブラウザ標準の選択欄 JSの読み込み前でもフォームの送信に値が載る
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
    return (
        <select
            data-slot="native-select"
            className={cn(
                "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-base text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 dark:[&>option]:bg-background",
                className,
            )}
            {...props}
        >
            {children}
        </select>
    );
}

export { NativeSelect };
