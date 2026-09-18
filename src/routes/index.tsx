import { createFileRoute } from "@tanstack/react-router";
import { StudioShell } from "@/components/studio-shell";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CityGLB — Real-world city blocks into a drivable 3D scene" },
      {
        name: "description",
        content:
          "Draw a box on the map, build the real streets and buildings in 3D, then drive it at street level with Street View side by side.",
      },
      { property: "og:title", content: "CityGLB — Real-world city blocks into a drivable 3D scene" },
      {
        property: "og:description",
        content:
          "Draw a box on the map, build the real streets and buildings in 3D, then drive it at street level with Street View side by side.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Home,
});

function Home() {
  return <StudioShell />;
}
