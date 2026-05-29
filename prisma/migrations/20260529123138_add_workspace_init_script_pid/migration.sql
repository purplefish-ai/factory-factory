-- Track the startup/setup script process while workspace provisioning is active.
ALTER TABLE "Workspace" ADD COLUMN "initScriptPid" INTEGER;
