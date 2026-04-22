const D = require('dota2');
const lobby = D.schema.CSODOTALobby;
if (!lobby) { console.log('CSODOTALobby NOT FOUND'); process.exit(1); }
try {
  const inst = lobby.decode(Buffer.alloc(0));
  console.log('CSODOTALobby keys:', Object.keys(inst).join(', '));
} catch(e) {
  console.log('Decode error:', e.message);
}

// Find the all_members field type from CSODOTALobby type definition
try {
  const defn = lobby.prototype.$$type || lobby.$type;
  if (defn) {
    const allMembersField = defn.children ? defn.children.find(c => c.name === 'all_members') : null;
    console.log('all_members field defn:', JSON.stringify(allMembersField));
  }
} catch(ex) { console.log('Field defn error:', ex.message); }

// Try to find the member type by name variations
const memberNames = ['CDOTALobbyMember', 'CLobbyMember', 'CSODOTALobbyMember', 'DOTALobbyMember'];
for (const name of memberNames) {
  if (D.schema[name]) {
    try {
      const inst2 = D.schema[name].decode(Buffer.alloc(0));
      console.log(name + ' keys:', Object.keys(inst2).join(', '));
    } catch(e2) { console.log(name + ' decode error:', e2.message); }
  }
}

// Also check DOTAChatChannelType_t
const chanType = D.schema.DOTAChatChannelType_t;
console.log('DOTAChatChannelType_t:', JSON.stringify(chanType));
