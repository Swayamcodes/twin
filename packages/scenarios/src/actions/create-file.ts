import { writeFile } from "node:fs/promises";

await writeFile("control-created.txt", "S12 control file.\n", { flag: "wx" });
