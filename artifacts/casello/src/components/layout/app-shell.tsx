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
  SidebarGroupLabel,
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
import { AlfredMark, BotcaveLogo, BotcaveMark, LuciusMark } from "@/components/brand/marks";
import { UserMenu } from "./user-menu";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/*
 * Due aree con i due personaggi di Botcave:
 * - Quartier generale (Alfred): dirigere il lavoro delle squadre e decidere;
 * - Officina (Lucius): analizzare e migliorare le applicazioni e costruire agenti, skill e squadre.
 */
interface NavArea {
  key: "hq" | "workshop";
  title: string;
  character: string;
  mark: ReactNode;
  items: NavItem[];
}

const NAV_AREAS: NavArea[] = [
  {
    key: "hq",
    title: "Quartier generale",
    character: "Alfred",
    mark: <AlfredMark size={13} />,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/teams", label: "Squadre", icon: Users },
      { href: "/pending-actions", label: "Da confermare", icon: ShieldCheck },
      { href: "/runs", label: "Run", icon: PlayCircle },
      { href: "/alfred", label: "Parla con Alfred", icon: Mic },
    ],
  },
  {
    key: "workshop",
    title: "Officina",
    character: "Lucius",
    mark: <LuciusMark size={13} />,
    items: [
      { href: "/apps", label: "App", icon: Boxes },
      { href: "/agents", label: "Agenti", icon: Bot },
      { href: "/skills", label: "Skill", icon: Sparkles },
      { href: "/team-templates", label: "Modelli di squadra", icon: LayoutTemplate },
      { href: "/models", label: "Modelli AI", icon: Cpu },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_AREAS.flatMap((area) => area.items);

function isActive(href: string, location: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

const UNREAD = { unread: true } as const;

function NavMenu({ location, items }: { location: string; items: NavItem[] }) {
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
      {items.map((item) => (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton asChild isActive={isActive(item.href, location)} tooltip={item.label}>
            {/* Su mobile la sidebar è un pannello sovrapposto: va chiusa dopo la scelta */}
            <Link href={item.href} onClick={() => setOpenMobile(false)}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
          {item.href === "/pending-actions" && pending > 0 && (
            <SidebarMenuBadge className="rounded-none bg-brand font-mono text-on-brand" title={`${pending} voci da confermare`}>
              {pending}
            </SidebarMenuBadge>
          )}
          {item.href === "/teams" && unread > 0 && (
            <SidebarMenuBadge className="font-mono text-accent-text" title={`${unread} notizie non lette nel bollettino`}>
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
          {/* Logo orizzontale (oltre 96 px); con la barra chiusa a icone solo il segno */}
          <Link href="/" className="flex items-center px-2 py-2" aria-label="Botcave, vai alla dashboard">
            <span className="flex group-data-[collapsible=icon]:hidden">
              <BotcaveLogo className="h-6" />
            </span>
            <span className="hidden group-data-[collapsible=icon]:flex">
              <BotcaveMark className="h-4" />
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent>
          {NAV_AREAS.map((area) => (
            <SidebarGroup key={area.key} aria-label={`${area.title} · ${area.character}`}>
              <SidebarGroupLabel className="h-7 gap-2 text-label text-ink-muted">
                <span className="flex w-6 justify-center">{area.mark}</span>
                <span className="truncate">
                  {area.title} · {area.character}
                </span>
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <NavMenu location={location} items={area.items} />
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <h1 className="text-label">{current?.label ?? "Botcave"}</h1>
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
