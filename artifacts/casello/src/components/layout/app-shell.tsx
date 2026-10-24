import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Bot, LayoutDashboard, PlayCircle, Boxes, type LucideIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

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
];

function isActive(href: string, location: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

function NavMenu({ location }: { location: string }) {
  const { setOpenMobile } = useSidebar();

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
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <h1 className="text-sm font-medium">{current?.label ?? "Casello"}</h1>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
