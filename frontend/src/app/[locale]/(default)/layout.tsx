import Footer from "@/components/site/footer";
import Header from "@/components/site/header";
import ScrollToTop from "@/components/scroll-to-top";
import { ReactNode } from "react";

export default function DefaultLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <ScrollToTop />
      <Header />
      <main className="flex-1 overflow-x-clip">{children}</main>
      <Footer />
    </div>
  );
}
