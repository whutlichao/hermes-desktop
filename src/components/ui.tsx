import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, X } from "lucide-react";
import { cn, copyText } from "../lib/ui";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet";

export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={cn("button", `button-${variant}`, className)} {...props} />;
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn("icon-action", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn("switch", checked && "is-on")}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(option.value === value && "is-active")}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatusDot({
  tone = "ok",
  ring = false,
  label,
}: {
  tone?: "ok" | "warn" | "error" | "idle" | "accent";
  ring?: boolean;
  label?: string;
}) {
  return <span className={cn("status-dot", `tone-${tone}`, ring && "ring")} aria-hidden="true" data-label={label} />;
}

export function useFocusTrap(active: boolean, ref: React.RefObject<HTMLElement | null>, onClose?: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active || !ref.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0);
    const first = focusables()[0];
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const current = document.activeElement as HTMLElement;
      if (event.shiftKey && current === list[0]) {
        event.preventDefault();
        list[list.length - 1].focus();
      } else if (!event.shiftKey && current === list[list.length - 1]) {
        event.preventDefault();
        list[0].focus();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [active, ref]);
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  className,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(open, ref, onClose);
  if (!open) return null;
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={ref}
        className={cn("modal", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </section>
    </div>
  );
}

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  className,
  toolbar,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  toolbar?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(open, ref, onClose);
  if (!open) return null;
  return (
    <div className="drawer-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={ref} className={cn("drawer", className)} role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <div>
            <h2 id="drawer-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className="drawer-head-actions">
            {toolbar}
            <IconButton label="关闭" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        </header>
        {children}
      </aside>
    </div>
  );
}

export function CopyButton({ value, compact = false }: { value: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cn("copy-button", compact && "is-compact")}
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {compact ? <span className="sr-only">{copied ? "已复制" : "复制"}</span> : copied ? "已复制" : "复制"}
    </button>
  );
}

function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return reactNodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const code = reactNodeText(children).replace(/\n$/, "");
  let language = "code";
  if (children && typeof children === "object" && "props" in children) {
    const className = (children as { props: { className?: string } }).props.className;
    if (className?.startsWith("language-")) language = className.slice(9);
  }
  return (
    <div className="code-frame">
      <div className="code-frame-head">
        <span>{language}</span>
        <CopyButton value={code} compact />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  children,
  action,
  className,
}: {
  tone?: "info" | "warn" | "danger" | "success";
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("inline-notice", `notice-${tone}`, className)} role={tone === "danger" ? "alert" : "status"}>
      <div>{children}</div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("field", className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("empty-state", className)}>
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Row({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("row", className)} {...props}>{children}</div>;
}

export function SectionTitle({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h3>{title}</h3>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}
