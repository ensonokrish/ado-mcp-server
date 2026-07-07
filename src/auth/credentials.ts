import * as keytar from "keytar";

const SERVICE_NAME = "ado-mcp-server";

export interface AdoProfile {
  name: string;
  organization: string;
  defaultProject?: string;
}

interface StoredProfile {
  organization: string;
  defaultProject?: string;
}

/**
 * Save a profile with PAT to the system keychain.
 */
export async function saveProfile(
  profileName: string,
  organization: string,
  pat: string,
  defaultProject?: string
): Promise<void> {
  const metadata: StoredProfile = { organization, defaultProject };
  // Store metadata as a JSON credential under a meta key
  await keytar.setPassword(SERVICE_NAME, `meta:${profileName}`, JSON.stringify(metadata));
  // Store the PAT separately
  await keytar.setPassword(SERVICE_NAME, `pat:${profileName}`, pat);
}

/**
 * Retrieve a profile's metadata and PAT from the keychain.
 */
export async function getProfile(
  profileName: string
): Promise<{ profile: AdoProfile; pat: string } | null> {
  const metaJson = await keytar.getPassword(SERVICE_NAME, `meta:${profileName}`);
  const pat = await keytar.getPassword(SERVICE_NAME, `pat:${profileName}`);

  if (!metaJson || !pat) {
    return null;
  }

  const metadata: StoredProfile = JSON.parse(metaJson);
  return {
    profile: {
      name: profileName,
      organization: metadata.organization,
      defaultProject: metadata.defaultProject,
    },
    pat,
  };
}

/**
 * List all saved profile names.
 */
export async function listProfiles(): Promise<AdoProfile[]> {
  const credentials = await keytar.findCredentials(SERVICE_NAME);
  const profiles: AdoProfile[] = [];

  for (const cred of credentials) {
    if (cred.account.startsWith("meta:")) {
      const name = cred.account.replace("meta:", "");
      const metadata: StoredProfile = JSON.parse(cred.password);
      profiles.push({
        name,
        organization: metadata.organization,
        defaultProject: metadata.defaultProject,
      });
    }
  }

  return profiles;
}

/**
 * Delete a profile from the keychain.
 */
export async function deleteProfile(profileName: string): Promise<boolean> {
  const metaDeleted = await keytar.deletePassword(SERVICE_NAME, `meta:${profileName}`);
  const patDeleted = await keytar.deletePassword(SERVICE_NAME, `pat:${profileName}`);
  return metaDeleted || patDeleted;
}
