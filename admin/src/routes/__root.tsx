import { Button, DropdownMenu, LinkButton, Sidebar } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  BooksIcon,
  BookmarkSimpleIcon,
  CloudArrowUpIcon,
  CodeIcon,
  DatabaseIcon,
  GaugeIcon,
  KeyIcon,
  ListIcon,
  ListChecksIcon,
  MonitorIcon,
  MoonIcon,
  QueueIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { formatForDisplay, HotkeysProvider, useHotkey } from "@tanstack/react-hotkeys";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import "../styles/globals.css";

const themeScript = `(function(){try{var p=localStorage.getItem("theme-mode");var m=p;if(p==="system"||p!=="light"&&p!=="dark"){m=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.mode=m;document.documentElement.style.colorScheme=m;}catch(e){}})()`;

const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const GITHUB_HREF = "https://github.com/jfalava/manifold";
const BRAND_TITLE = "MANIFOLD";
const BRAND_SUBTITLE = "Admin Panel";
const DOCUMENT_TITLE = "MANIFOLD/admin";
const SIDEBAR_HOTKEY = "Mod+B";

const SIDEBAR_SHORTCUT_SSR = formatForDisplay(SIDEBAR_HOTKEY, { platform: "windows" });

function subscribeSidebarShortcut(): () => void {
  // Platform is fixed for the session; nothing to subscribe to.
  return () => undefined;
}

function getSidebarShortcut(): string {
  return formatForDisplay(SIDEBAR_HOTKEY);
}

function getSidebarShortcutServer(): string {
  return SIDEBAR_SHORTCUT_SSR;
}

interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "Dashboard",
    items: [{ label: "Overview", path: "/", icon: GaugeIcon }],
  },
  {
    label: "Library",
    items: [
      { label: "Registry", path: "/registry", icon: BooksIcon },
      {
        label: "MangaDex Library",
        path: "/mangadex-library",
        icon: BookmarkSimpleIcon,
      },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Sync operations", path: "/operations", icon: QueueIcon },
      { label: "Credentials", path: "/credentials", icon: KeyIcon },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Durable Objects", path: "/durable-objects", icon: DatabaseIcon },
      { label: "Cache", path: "/cache", icon: CloudArrowUpIcon },
      { label: "Requests", path: "/requests", icon: ListChecksIcon },
    ],
  },
];

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: DOCUMENT_TITLE },
      {
        name: "description",
        content:
          "Manifold admin — library, sync operations, and infrastructure on manifold.jfa.dev.",
      },
      { name: "theme-color", content: "oklch(0.511 0.262 276.966)" },
      { name: "author", content: "Jorge Fernando Álava" },
    ],
    links: [{ rel: "me", href: "https://github.com/jfalava" }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" data-theme="kumo">
      <head>
        <HeadContent />
        {/* oxlint-disable-next-line react/no-danger -- must run inline before paint to avoid a theme flash; content is a static constant */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <HotkeysProvider
          defaultOptions={{
            hotkey: { preventDefault: true },
          }}
        >
          <DashboardShell />
        </HotkeysProvider>
        <Scripts />
      </body>
    </html>
  );
}

/**
 * jfa SiteHeader (full-bleed) — matches common/site-header anatomy with Kumo
 * primitives instead of react-aria. Full-bleed above the left-rail + content row.
 */
function SiteHeader({ children }: { readonly children?: ReactNode }) {
  return (
    <header className="site-header sticky top-0 z-30 shrink-0 border-b border-kumo-line bg-kumo-canvas">
      <div className="flex min-h-11 items-center justify-between gap-4 px-2 sm:gap-6 sm:px-3 lg:gap-8 lg:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <a
            href={`${base}/`}
            aria-label={`${BRAND_TITLE} by JFA`}
            className="flex min-w-0 items-baseline gap-3 truncate no-underline lg:pr-4"
          >
            <span className="shrink-0 text-sm font-bold tracking-tight text-kumo-brand">
              <span className="hidden sm:inline">{BRAND_TITLE}</span>
              <span className="inline sm:hidden">{BRAND_TITLE}</span>
              <span className="hidden pl-0.5 text-xs tracking-tight sm:inline">by JFA</span>
            </span>
            <span className="hidden text-[11px] text-kumo-subtle/75 sm:inline">/</span>
            <span className="hidden truncate text-[11px] text-kumo-subtle sm:inline">
              {BRAND_SUBTITLE}
            </span>
          </a>
        </div>

        <nav className="flex shrink-0 items-center gap-1" aria-label="Admin navigation">
          {children}
          <LinkButton
            href={GITHUB_HREF}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-kumo-subtle hover:text-kumo-default"
          >
            <CodeIcon className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Source</span>
            <ArrowSquareOutIcon className="hidden size-4 lg:inline" aria-hidden="true" />
          </LinkButton>
        </nav>
      </div>
    </header>
  );
}

function DashboardShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // Controlled so the full-bleed SiteHeader can toggle without nesting inside
  // Sidebar.Provider (contained mode positions the rail absolute to the wrapper).
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useHotkey(
    SIDEBAR_HOTKEY,
    () => {
      setSidebarOpen((open) => !open);
    },
    {
      meta: { name: "Toggle sidebar", description: "Open or close the admin navigation" },
    },
  );

  const sidebarLabel = sidebarOpen ? "Collapse sidebar" : "Open sidebar";
  const sidebarShortcut = useSyncExternalStore(
    subscribeSidebarShortcut,
    getSidebarShortcut,
    getSidebarShortcutServer,
  );

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      {/* Full-bleed header — never nested inside the content frame */}
      <SiteHeader>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          icon={ListIcon}
          aria-label={`${sidebarLabel} (${sidebarShortcut})`}
          aria-keyshortcuts="Control+B Meta+B"
          aria-expanded={sidebarOpen}
          aria-controls="admin-sidebar"
          className="gap-1.5 px-2 text-kumo-subtle hover:text-kumo-default"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <span className="hidden sm:inline">{sidebarOpen ? "Collapse" : "Menu"}</span>
          <kbd className="hidden items-center rounded border border-kumo-line bg-kumo-fill px-1.5 py-0.5 text-[0.625rem] font-medium text-kumo-subtle lg:inline-flex">
            {sidebarShortcut}
          </kbd>
        </Button>
      </SiteHeader>

      {/*
        Sidebar flush to the left edge of the viewport.
        Main scrolls independently; page body is max-w centered until the
        viewport is narrower than the content max, then it fills full width.
      */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar.Provider
          collapsible="icon"
          contained
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className="min-h-0 min-w-0 flex-1"
        >
          <Sidebar id="admin-sidebar" className="h-full min-h-0 border-r border-kumo-line">
            <Sidebar.Content>
              {navGroups.map((group) => (
                <Sidebar.Group key={group.label}>
                  <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
                  <Sidebar.Menu>
                    {group.items.map((item) => {
                      const isActive =
                        item.path === "/"
                          ? pathname === "/" || pathname === ""
                          : pathname.startsWith(item.path);
                      return (
                        <Sidebar.MenuItem key={item.path}>
                          <Sidebar.MenuButton
                            icon={item.icon}
                            href={`${base}${item.path === "/" ? "" : item.path}`}
                            active={isActive}
                            tooltip={item.label}
                          >
                            {item.label}
                          </Sidebar.MenuButton>
                        </Sidebar.MenuItem>
                      );
                    })}
                  </Sidebar.Menu>
                </Sidebar.Group>
              ))}
            </Sidebar.Content>
          </Sidebar>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </Sidebar.Provider>
      </div>
    </div>
  );
}

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

function getStoredTheme(): ThemeMode {
  try {
    const value = localStorage.getItem("theme-mode");
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
    return "system";
  } catch {
    return "system";
  }
}

function getResolvedTheme(preference: ThemeMode): ResolvedTheme {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeMode(mode: ThemeMode) {
  const resolved = getResolvedTheme(mode);
  document.documentElement.dataset.mode = resolved;
  document.documentElement.style.colorScheme = resolved;
  try {
    localStorage.setItem("theme-mode", mode);
  } catch {
    // ignore private-browsing storage failures
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

const THEME_CHANGE_EVENT = "theme-mode-change";

function subscribeThemeMode(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    if (getStoredTheme() === "system") {
      const resolved = media.matches ? "dark" : "light";
      document.documentElement.dataset.mode = resolved;
      document.documentElement.style.colorScheme = resolved;
    }
    onChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === "theme-mode") {
      const preference = getStoredTheme();
      const resolved = getResolvedTheme(preference);
      document.documentElement.dataset.mode = resolved;
      document.documentElement.style.colorScheme = resolved;
      onChange();
    }
  };
  media.addEventListener("change", handleMediaChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    media.removeEventListener("change", handleMediaChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

const themeLabels = {
  light: "Light",
  dark: "Dark",
  system: "System",
} as const satisfies Record<ThemeMode, string>;

/** Header theme control — matches jfa ThemeToggle (icon + label, dropdown). */
function ThemeToggle() {
  const preference: ThemeMode = useSyncExternalStore(
    subscribeThemeMode,
    getStoredTheme,
    (): ThemeMode => "system",
  );

  const ThemeIcon =
    preference === "light" ? SunIcon : preference === "dark" ? MoonIcon : MonitorIcon;
  const label = themeLabels[preference];

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 px-2 text-kumo-subtle hover:text-kumo-default"
            aria-label={`Theme: ${label}`}
          >
            <ThemeIcon className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.Item
          icon={SunIcon}
          selected={preference === "light"}
          onClick={() => applyThemeMode("light")}
        >
          Light
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={MoonIcon}
          selected={preference === "dark"}
          onClick={() => applyThemeMode("dark")}
        >
          Dark
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={MonitorIcon}
          selected={preference === "system"}
          onClick={() => applyThemeMode("system")}
        >
          System
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
