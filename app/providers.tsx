"use client";

import { getDefaultConfig, lightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { arcChain } from "@/lib/network";
import { WagmiProvider } from "wagmi";


export default function Providers({ children }: { children: ReactNode }) {
  const [config] = useState(() => getDefaultConfig({
    appName: "PrePaid",
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
    chains: [arcChain],
    ssr: true,
  }));
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme({ accentColor: "#6554d9", accentColorForeground: "white", borderRadius: "medium" })}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
