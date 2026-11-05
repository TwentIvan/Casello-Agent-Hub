import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Bot, Cpu, LayoutDashboard, PlayCircle, Boxes, ShieldCheck, Sparkles, LayoutTemplate, Users, Mic, type LucideIcon } from "lucide-react";
import {
  getGetDashboardStatsQueryKey,
  getListUnreadTeamEventsQueryKey,
  useGetDashboardStats,
  useListUnreadTeamEvents,
} from "@workspace/api-client-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { BudgetGuard } from "@/components/budget/budget";
import { UserMenu } from "./user-menu";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/apps", label: "App", icon: Boxes },
  { href: "/agents", label: "Agenti", icon: Bot },
  { href: "/runs", label: "Run", icon: PlayCircle },
  { href: "/pending-actions", label: "Da confermare", icon: ShieldCheck },
  { href: "/models", label: "Modelli", icon: Cpu },
  { href: "/skills", label: "Skill", icon: Sparkles },
  { href: "/team-templates", label: "Modelli di squadra", icon: LayoutTemplate },
  { href: "/teams", label: "Squadre", icon: Users },
  { href: "/alfred", label: "Alfred", icon: Mic },
];

function isActive(href: string, location: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

const UNREAD = { unread: true } as const;

function NavMenu({ location }: { location: string }) {
  const { setOpenMobile } = useSidebar();
  // Contatore delle azioni in attesa: si riallinea ogni 30 s e quando si torna sulla finestra.
  const stats = useGetDashboardStats({ query: { queryKey: getGetDashboardStatsQueryKey(), refetchInterval: 30_000 } });
  const pending = stats.data?.pendingActions ?? 0;
  // Notizie non lette del bollettino delle squadre attivate dall'utente
  const events = useListUnreadTeamEvents(UNREAD, {
    query: { queryKey: getListUnreadTeamEventsQueryKey(UNREAD), refetchInterval: 30_000 },
  });
  const unread = events.data?.length ?? 0;

  return (
    <SidebarMenu>
      {NAV_ITEMS.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton asChild isActive={isActive(item.href, location)} tooltip={item.label}>
            {/* Su mobile la sidebar è un pannello sovrapposto: va chiusa dopo la scelta */}
            <Link href={item.href} onClick={() => setOpenMobile(false)}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
          {item.href === "/pending-actions" && pending > 0 && (
            <SidebarMenuBadge className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {pending}
            </SidebarMenuBadge>
          )}
          {item.href === "/teams" && unread > 0 && (
            <SidebarMenuBadge
              className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
              title={`${unread} notizie non lette nel bollettino`}
            >
              {unread}
            </SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const current = NAV_ITEMS.find((item) => isActive(item.href, location));

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <Link href="/" className="flex items-center gap-2 px-2 py-1.5 font-semibold">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
              C
            </span>
            <span className="truncate group-data-[collapsible=icon]:hidden">Casello</span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavMenu location={location} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <h1 className="text-sm font-medium">{current?.label ?? "Casello"}</h1>
          <div className="ml-auto">
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
        <BudgetGuard />
      </SidebarInset>
    </SidebarProvider>
  );
}
