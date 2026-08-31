import { Badge, Button, Sidebar, SidebarTrigger, Text } from "@cloudflare/kumo";
import {
  Books,
  BookmarkSimple,
  CloudArrowUp,
  Database,
  Gauge,
  ListChecks,
  Monitor,
  Moon,
  Queue,
  Sun,
} from "@phosphor-icons/react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { useSyncExternalStore, type ComponentType } from "react";

import "../styles/globals.css";

const themeScript = `(function(){try{var p=localStorage.getItem("theme-mode");var m=p;if(p==="system"||p!=="light"&&p!=="dark"){m=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.mode=m;document.documentElement.style.colorScheme=m;}catch(e){}})()`;

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

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
    items: [{ label: "Overview", path: "/", icon: Gauge }],
  },
  {
    label: "Library",
    items: [
      { label: "Registry", path: "/registry", icon: Books },
      {
        label: "MangaDex Library",
        path: "/mangadex-library",
        icon: BookmarkSimple,
      },
    ],
  },
  {
    label: "Operations",
    items: [{ label: "Sync operations", path: "/operations", icon: Queue }],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Durable Objects", path: "/durable-objects", icon: Database },
      { label: "Cache", path: "/cache", icon: CloudArrowUp },
      { label: "Requests", path: "/requests", icon: ListChecks },
    ],
  },
];

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Manga Sync admin" },
    ],
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
        <DashboardShell />
        <Scripts />
      </body>
    </html>
  );
}

function DashboardShell() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <div className="min-h-svh">
      <div className="mx-auto flex h-svh max-w-screen-2xl border-x border-kumo-line">
        <Sidebar.Provider collapsible="icon" defaultOpen contained className="h-full min-h-0">
          <Sidebar className="h-full">
            <Sidebar.Header>
              <div className="flex w-full items-center gap-2">
                <SidebarTrigger />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Text as="span" bold>
                    Manga Sync
                  </Text>
                  <Badge variant="beta">admin</Badge>
                </div>
              </div>
            </Sidebar.Header>
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
            <Sidebar.Footer className="h-auto min-h-12 py-2">
              <ThemeToggle />
            </Sidebar.Footer>
            <Sidebar.Rail />
          </Sidebar>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
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

function ThemeToggle() {
  const preference = useSyncExternalStore(subscribeThemeMode, getStoredTheme, () => "system");

  return (
    <div className="flex items-center gap-1">
      <Button
        variant={preference === "light" ? "primary" : "ghost"}
        size="sm"
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- external Kumo Button prop; not an owned symbol
        shape="square"
        icon={Sun}
        aria-label="Light mode"
        aria-pressed={preference === "light"}
        onClick={() => applyThemeMode("light")}
      />
      <Button
        variant={preference === "dark" ? "primary" : "ghost"}
        size="sm"
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- external Kumo Button prop; not an owned symbol
        shape="square"
        icon={Moon}
        aria-label="Dark mode"
        aria-pressed={preference === "dark"}
        onClick={() => applyThemeMode("dark")}
      />
      <Button
        variant={preference === "system" ? "primary" : "ghost"}
        size="sm"
        // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- external Kumo Button prop; not an owned symbol
        shape="square"
        icon={Monitor}
        aria-label="System mode"
        aria-pressed={preference === "system"}
        onClick={() => applyThemeMode("system")}
      />
    </div>
  );
}
