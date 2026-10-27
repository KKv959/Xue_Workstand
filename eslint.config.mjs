import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname
});

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".dev-server/**",
      ".dev-sandbox/**",
      ".remote-server/**",
      "dist/**",
      "node_modules/**",
      "output/**",
      "outputs/**",
      "style-library/**",
      "next-env.d.ts"
    ]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript")
];

export default eslintConfig;
