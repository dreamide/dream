import { installFixtureBridge } from "./fixture-bridge";
import "../app/fonts";
import "../app/globals.css";

if (import.meta.env.DEV) {
  installFixtureBridge();
  void import("./fixture-app").then(({ mountFixtures }) => mountFixtures());
}
