"use strict";

function deserializeHeader(reader) {
	const rootId = reader.read32();
	const headerId = reader.read32();
	const majorVersion = reader.read32();
	const minorVersion = reader.read32();

	return {
		rootId,
		headerId,
		majorVersion,
		minorVersion
	};
}

function deserializeBinaryLibrary(reader) {
	const id = reader.read32();
	const name = reader.readLengthPrefixedString();
	return {
		id,
		name
	};
}

function deserializeAdditionalTypeInfo(reader, type) {
		switch (type) {
		case 1: // String
		case 2: // Object
		case 5: // ObjectArray
		case 6: // StringArray
			return null;
		case 0: // Primitive
			return reader.read8();
		case 3: // SystemClass
			return reader.readLengthPrefixedString();
		case 4: // Class
			return {
				className: reader.readLengthPrefixedString(),
				libraryId: reader.read32()
			};
		case 7: // PrimitiveArray
			return reader.read8();
		}
}

function deserializeClassWithMembersAndTypes(reader, state, isSystem) {
	const objectId = reader.read32();
	const name = reader.readLengthPrefixedString();
	const memberCount = reader.read32();
	const memberNames = [];
	const members = {};
	for (let i = 0; i < memberCount; i++) {
		memberNames.push(reader.readLengthPrefixedString());
	}
	// 2.3.1.2 MemberTypeInfo
	const memberTypes = [];
	const additionalInfos = [];
	for (let i = 0; i < memberCount; i++) {
		memberTypes.push(reader.read8());
	}
	for (let i = 0; i < memberCount; i++) {
		additionalInfos.push(deserializeAdditionalTypeInfo(reader, memberTypes[i]));
	}
	let libraryId = null;
	if (!isSystem) {
		libraryId = reader.read32();
	}

	return {
		objectId,
		name,
		memberNames,
		memberTypes,
		additionalInfos,
		libraryId,
		memberValues: []
	};
}

function deserializeBinaryObjectString(reader) {
	const objectId = reader.read32();
	const value = reader.readLengthPrefixedString();
	return {
		objectId,
		value
	};
}

function deserializeMemberReference(reader) {
	return reader.read32();
}

function deserializePrimitiveType(reader, type) {
	switch (type) {
		case 0: // unused
			throw "Unmapped primitive 0.";
		case 1: // boolean
			return !!reader.read8();
		case 2: // byte
			return reader.read8();
		case 3: // char
			return reader.read8();
		case 4: // unused
			throw "Unmapped primitive 4.";
		case 5: // decimal
			return reader.readLengthPrefixedString();
		case 6: // double
			return reader.readDouble();
		case 7: // int16
			return reader.read16();
		case 8: // int32
			return reader.read32();
		case 9: // int64
			return reader.read64();
		case 10: // sbyte
			const val = reader.read7();
			const negative = reader.read1();
			if (negative) val = -128 + val;
			return val;
		case 11: // single
			return reader.readSingle();
		case 12: // timespan
			return reader.read64(); // TODO: This isn't right.
		case 13: // datetime
			return reader.read64(); // TODO: This isn't right.
		case 14: // uint16
			return reader.read16(); // TODO: This isn't right.
		case 15: // uint32
			return reader.read32(); // TODO: This isn't right.
		case 16: // uint64
			return reader.read64(); // TODO: This isn't right.
		case 17: // null
			return null;
		case 18: // string
			return reader.readLengthPrefixedString();
	}
}

function mapMembers(obj) {
	if (!obj || !obj.memberValues) {
		// This is a simple value.
		return obj;
	}

	// This is a nested class of some kind.

	if (obj.rank) {
		// this is a binaryarray type object.
		return obj.memberValues.map(mapMembers);
	}

	const members = {};
	for (const idx in obj.memberNames) {
		if (obj.memberNames[idx] === "_items" || obj.memberNames[idx] === "value__") {
			// This is an array or enum; return the items or value as the entire object for simplicity.
			return mapMembers(obj.memberValues[idx]);
		}

		members[obj.memberNames[idx]] = mapMembers(obj.memberValues[idx]);
	}

	return members;
}

function deserialize(str) {
	const reader = bitReader(str);
	const state = {
		libraries: [],
		objects: {},
		references: [],
		objectStack: []
	}
	const result = {
	};
	while (true) {
		const currentObject = state.objectStack[state.objectStack.length - 1];
		if (currentObject) {
			// Handle un-prefixed records
			const currentMemberIdx = currentObject.memberValues.length;
			if (currentMemberIdx < currentObject.memberTypes.length) {
				// Still more members in the current class.
				const memberType = currentObject.memberTypes[currentMemberIdx];
				if (memberType === 0) {
					// Primitive type - no record prefix.
					currentObject.memberValues[currentMemberIdx] = deserializePrimitiveType(reader, currentObject.additionalInfos[currentMemberIdx]);
					continue;
				}
				// Not a primitive type, we need to decode the record.
			} else {
				// We're done with this class.
				state.objectStack.pop();
				continue;
			}
		}
		const record = reader.read8();
		switch (record) {
			case 0x00: // SerializationHeaderRecord
				result.header = deserializeHeader(reader, state);
				break;
			case 0x01: // ClassWithId
				const objectId = reader.read32();
				const metadataId = reader.read32();
				const cls1 = {...state.objects[metadataId]};
				cls1.memberValues = [];
				cls1.objectId = objectId;
				if (currentObject) {
					currentObject.memberValues.push(cls1);
				}
				state.objectStack.push(cls1);
				state.objects[cls1.objectId] = cls1;
				break;
			case 0x04: // SystemClassWithMembersAndTypesRecord
			case 0x05: // ClassWithMembersAndTypesRecord
				const cls = deserializeClassWithMembersAndTypes(reader, state, record === 0x04);
				if (currentObject) {
					currentObject.memberValues.push(cls);
				}
				state.objectStack.push(cls);
				state.objects[cls.objectId] = cls;
				break;
			case 0x06: // BinaryObjectString
				const bos = deserializeBinaryObjectString(reader);
				state.objects[bos.objectId] = bos.value;
				currentObject.memberValues.push(bos.value);
				break;
			case 0x07: // BinaryArray
				const binaryArrayObjectId = reader.read32();
				const binaryArrayType = reader.read8();
				const rank = reader.read32();
				const lengths = [];
				const lowerBounds = [];
				for(let i = 0; i < rank; i++) {
					lengths.push(reader.read32());
				}
				if (binaryArrayType > 2) {
					for(let i = 0; i < rank; i++) {
						lowerBounds.push(reader.read32());
					}
				}
				const binaryArrayItemType = reader.read8();
				const additionalInfo = deserializeAdditionalTypeInfo(reader, binaryArrayItemType);

				const totalLength = lengths.reduce((x,y) => x + y);
				const binaryArrayObj = {
					objectId: binaryArrayObjectId,
					rank,
					lengths,
					lowerBounds,
					itemType: binaryArrayItemType,
					additionalInfos: Array(totalLength).fill(additionalInfo),
					memberValues: [],
					memberTypes: Array(totalLength).fill(binaryArrayItemType)
				};
				state.objects[binaryArrayObjectId] = binaryArrayObj;
				state.objectStack.push(binaryArrayObj);
				break;
			case 0x09: // MemberReference
				const reference = deserializeMemberReference(reader);
				const idx = currentObject.memberValues.length;
				state.references.push(() => currentObject.memberValues[idx] = state.objects[reference]);
				currentObject.memberValues.push({ref: reference});
				break;
			case 0x0A: // ObjectNull
				currentObject.memberValues.push(null);
				break;
			case 0x0B: // MessageEnd
				for (const r of state.references) {
					r();
				}
				const c = Object.values(state.objects)[0];
				return mapMembers(c);
			case 0x0C: // BinaryLibraryRecord
				state.libraries.push(deserializeBinaryLibrary(reader));
				break;
			case 0x0D: // ObjectNull256
				const nullCount = reader.read8();
				Array.prototype.push.apply(currentObject.memberValues, Array(nullCount).fill(null));
				break;
			case 0x0F: // ArraySinglePrimitive
				const arrayObjectId = reader.read32();
				const length = reader.read32();
				const type = reader.read8();
				const array = [];
				for (let i = 0; i < length; i++) {
					array.push(deserializePrimitiveType(reader, type));
				}
				state.objects[arrayObjectId] = array;
				break;
			default:
				debugger;
				throw "unable to deserialize record of type " + record + ".";
		}
	}
}

function bitReader(str) {
	const bytes = str.split("").map(c=>c.charCodeAt(0));
	if (bytes[0] != 0) {
		throw "Unable to deserialize.";
	}

	let bit = 0;
	function peek(bits) {
		var result = read(bits);
		bit -= bits;
		return result;
	}
	function read(bits) {
		const startByte = Math.floor(bit / 8);
		const endByte = Math.ceil((bit + bits) / 8);
		const b = bytes.slice(startByte, endByte);
		let result = reduce(b);
		const mask = Math.pow(2, bits) - 1;
		result >>= (bit % 8);

		bit += bits;
		const f = result & mask;
		return f;
	}

	function readByteArray(count) {
		const ret = bytes.slice(bit / 8, (bit / 8) + count);
		bit += count * 8;
		return ret;
	}

	function reduce(array) {
		let result = 0;
		let k = 0;
		for (const b of array) {
			result += (b << (k * 8));
			k++;
		}
		return result;
	}

	return {
		peek: (c) => peek(c),
		read: (c) => read(c),
		read8: () => read(8),
		read16: () => read(16),
		read32: () => read(32),
		read64: () => read(64),
		readSingle: () => {
			var buffer = new ArrayBuffer(8);
			(new Uint32Array(buffer))[0] = read(32);
			return new Float32Array(buffer)[0];
		},
		readDouble: () => {
			var buffer = new ArrayBuffer(8);
			(new Uint32Array(buffer))[0] = read(32);
			(new Uint32Array(buffer))[1] = read(32);
			return new Float64Array(buffer)[0];
		},
		readLengthPrefixedString: () => {
			let multiplier = 0;
			let len = 0;
			for (let j = 0; j < 5; j++) {
				const nextLength = read(7);
				len += (nextLength << multiplier * 7);
				multiplier ++;
				if (!read(1)) {
					break;
				}
			}
			const charArray = readByteArray(len);
			// TODO: decode UTF-8 correctly
			const string = charArray.map(x => String.fromCharCode(x)).join("");
			return string;
		},
		bytes: bytes,
	}
}

function handleFileSelect(evt) {
	const files = evt.target.files;

	for (const f of files) {
		const reader = new FileReader();
		reader.onload = (function (theFile) {
			return function (e) {
				const t = atob(e.target.result)
				const pre = document.createElement('pre');
				const data = deserialize(t);
				const playerData = atob(data.playerData)
				const decodedPlayerData = deserialize(playerData);
				pre.innerText = JSON.stringify(decodedPlayerData, null, 2);
				document.getElementById('list').insertBefore(pre, null);
			};
		})(f);

		reader.readAsText(f);
	}
}

document.getElementById('files').addEventListener('change', handleFileSelect, false);
