// RFC 8785 JSON canonicalization for JSON data: ECMAScript primitive encoding
// and recursively sorted UTF-16 property names. Reject non-JSON values.
export function canonical(value){
 if(typeof value==='string'&&!value.isWellFormed())throw Error('Invalid Unicode');
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Non-JSON number');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>canonical(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('Non-JSON value');
}
