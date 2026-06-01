import React from "react";

import { PackageTrackerCard, type PackageTrackerCardProps } from "@/components/ui/tracker-card";

const IndiaFlag = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" className="h-4 w-6 rounded-sm">
    <rect width="900" height="200" fill="#ff9933" />
    <rect y="200" width="900" height="200" fill="#fff" />
    <rect y="400" width="900" height="200" fill="#138808" />
    <circle cx="450" cy="300" r="42" fill="none" stroke="#000080" strokeWidth="10" />
  </svg>
);

const PackageTrackerCardDemo = () => {
  const trackingUrl = "https://21st.dev/track/49029880150810129411";

  const cardProps: PackageTrackerCardProps = {
    status: "Out for Delivery",
    packageNumber: "49029880150810129411",
    destination: "India",
    destinationFlag: <IndiaFlag />,
    date: "India - 01/06/25",
    qrCodeValue: trackingUrl,
    packageImage: (
      <img
        src="https://images.unsplash.com/photo-1566576912321-d58ddd7a6088?auto=format&fit=crop&w=320&q=75"
        width={200}
        height={200}
        className="drop-shadow-lg"
        alt="Delivery boxes ready for shipment."
      />
    ),
    onTrackClick: () => undefined,
  };

  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-background p-4">
      <PackageTrackerCard {...cardProps} />
    </div>
  );
};

export default PackageTrackerCardDemo;
