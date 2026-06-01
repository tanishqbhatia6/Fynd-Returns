import { PackageCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusCard } from "@/components/ui/card-24";

export default function StatusCardDemo() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <StatusCard
        icon={<PackageCheck className="h-6 w-6" />}
        title="On its way"
        description="Your order has been dispatched and is now with the courier."
        illustration="https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&w=320&q=75"
        illustrationAlt="Delivery boxes ready for shipment."
      >
        <Button variant="outline" size="sm">
          Track Package
        </Button>
      </StatusCard>
    </div>
  );
}
