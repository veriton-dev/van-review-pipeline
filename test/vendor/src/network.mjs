export const ENVIRONMENT=process.env.VAN_NETWORK??'testnet';
if(!['testnet','mainnet'].includes(ENVIRONMENT))throw Error('Choose VAN_NETWORK=testnet or mainnet');
export const NETWORK=Object.freeze(ENVIRONMENT==='mainnet'?{profileId:'base-mainnet',chainId:8453,network:'eip155:8453',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',decimals:6,audience:'https://api.thevan.app'}:{profileId:'base-sepolia',chainId:84532,network:'eip155:84532',asset:'0x036cbd53842c5426634e7929541ec2318f3dcf7e',decimals:6,audience:'https://test-api.thevan.app'});
export function validateIdentity(config){
 if(!config||config.chainId!==NETWORK.chainId||config.origin!==NETWORK.audience||
  (config.profileId!==undefined&&config.profileId!==NETWORK.profileId)||(ENVIRONMENT==='mainnet'&&(config.environmentId!=='mainnet'||config.profileId!==NETWORK.profileId)))throw Error('State belongs to a different VAN network or API; preserve it and use a separate state directory');
 return config;
}
export function validateDescriptor(d){
 if(!d||d.version!==1||Object.keys(d).sort().join(',')!=='asset,audience,chainId,decimals,network,profileId,version'||Object.keys(NETWORK).some(k=>d[k]!==NETWORK[k]))throw Error('Server network context mismatch; no credential or payment sent');
 return d;
}

export const AUTHORIZATION_DOMAIN=Object.freeze({name:ENVIRONMENT==='mainnet'?'USD Coin':'USDC',version:'2'});
export function validateDeploymentDescriptor(d){if(!d||Object.keys(d).sort().join(',')!=='asset,audience,chainId,decimals,environmentId,network,profileId,version'||d.version!==2||d.environmentId!==ENVIRONMENT||Object.keys(NETWORK).some(k=>d[k]!==NETWORK[k]))throw Error('Server deployment context mismatch; no credential or payment sent');return d;}

export const STATE_CONTEXT=Object.freeze({environmentId:ENVIRONMENT,profileId:NETWORK.profileId,chainId:NETWORK.chainId,audience:NETWORK.audience});
export function requireStateContext(value){if(ENVIRONMENT==='mainnet'&&JSON.stringify(value?.deployment)!==JSON.stringify(STATE_CONTEXT))throw Error('Saved work belongs to a different deployment; no request sent');}
