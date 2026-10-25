import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

// Segnaposto per le sezioni non ancora realizzate (vedi le issue della UI).
export default function ComingSoon({ title }: { title: string }) {
  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <Construction className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">Questa sezione è in costruzione.</p>
      </CardContent>
    </Card>
  );
}
