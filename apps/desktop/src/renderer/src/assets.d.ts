/** Declaración de assets de imagen para el renderer (Vite los empaqueta). */
declare module "*.png" {
  const url: string;
  export default url;
}
