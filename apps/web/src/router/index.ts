import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/register",
      name: "register",
      component: () => import("@/views/RegisterView.vue"),
      meta: { public: true },
    },
    {
      path: "/share/:token",
      name: "share",
      component: () => import("@/views/ShareView.vue"),
      meta: { public: true },
    },
    {
      path: "/",
      component: () => import("@/components/AppShell.vue"),
      children: [
        { path: "", name: "timeline", component: () => import("@/views/TimelineView.vue") },
        { path: "observations/new", name: "observation-new", component: () => import("@/views/ObservationEditView.vue") },
        { path: "observations/:id", name: "observation-detail", component: () => import("@/views/ObservationDetailView.vue") },
        { path: "observations/:id/edit", name: "observation-edit", component: () => import("@/views/ObservationEditView.vue") },
        { path: "sites", name: "sites", component: () => import("@/views/SitesView.vue") },
        { path: "species", name: "species", component: () => import("@/views/SpeciesView.vue") },
        { path: "compare", name: "compare", component: () => import("@/views/CompareView.vue") },
        { path: "stats", name: "stats", component: () => import("@/views/StatsView.vue") },
        { path: "quality", name: "quality", component: () => import("@/views/QualityView.vue") },
        { path: "settings", name: "settings", component: () => import("@/views/SettingsView.vue") },
      ],
    },
    { path: "/:pathMatch(.*)*", name: "not-found", component: () => import("@/views/NotFoundView.vue") },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();

  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (to.meta.public && auth.isAuthenticated && (to.name === "login" || to.name === "register")) {
    return { name: "timeline" };
  }

  return true;
});

export default router;
