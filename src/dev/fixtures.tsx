import { installFixtureBridge } from "./fixture-bridge";
import "../app/globals.css";

if (import.meta.env.DEV) {
  installFixtureBridge();
  void import("./fixture-app").then(({ mountFixtures }) => mountFixtures());
}
