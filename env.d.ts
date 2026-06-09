/// <reference types="vite/client" />
/// <reference types="@react-router/node" />

declare module "react-router" {
  interface LoaderFunctionArgs<Context = any> {
    unstable_pattern?: string;
    url?: string;
    pattern?: string;
  }

  interface ActionFunctionArgs<Context = any> {
    unstable_pattern?: string;
    url?: string;
    pattern?: string;
  }
}

export {};
