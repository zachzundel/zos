import _ from 'lodash';
import { getBuildArtifacts } from "../utils/BuildArtifacts";

export function getStorageLayout(contract, artifacts) {
  if (!artifacts) artifacts = getBuildArtifacts();
  const layout = new StorageLayout(contract, artifacts)
  const { types, storage } = layout.run()
  return { types, storage }
}

class StorageLayout {
  constructor (contract, artifacts) {
    this.artifacts = artifacts
    this.contract = contract
    this.imports = new Set() // Transitive closure of source files imported from the contract
    this.nodes = {} // Map from ast id to node across all visited contracts
    this.types = {} // Types info being collected for the current contract
    this.storage = [] // Storage layout for the current contract
    
  }

  run() {
    this.collectImports(this.contract.ast)
    this.collectNodes(this.contract.ast)
    
    this.getLinearizedBaseContracts().forEach(contractNode => {
      this.visitVariables(contractNode)
    })
    
    return this
  }

  collectImports(ast) {
    ast.nodes
      .filter(node => node.nodeType === 'ImportDirective')
      .map(node => node.absolutePath)
      .forEach(importPath => {
        if (this.imports.has(importPath)) return;
        this.imports.add(importPath);
        this.artifacts.getArtifactsFromSourcePath(importPath).forEach(importedArtifact => {
          this.collectNodes(importedArtifact.ast)
          this.collectImports(importedArtifact.ast)
        })
      })
  }

  collectNodes(node) {
    if (this.nodes[node.id]) return;
    this.nodes[node.id] = node
    if (node.nodes) node.nodes.forEach(this.collectNodes.bind(this))
  }

  visitVariables(contractNode) {
    const varNodes = contractNode.nodes.filter(node => node.stateVariable && !node.constant)
    varNodes.forEach(node => {
      const typeInfo = this.getTypeInfo(node.typeName)
      this.registerType(typeInfo)
      const storageInfo = { contract: contractNode.name, ... this.getStorageInfo(node, typeInfo) }
      this.storage.push(storageInfo)
    })
  }

  registerType(typeInfo) {
    this.types[typeInfo.id] = typeInfo
  }

  getContractNode() {
    return this.contract.ast.nodes.find(node => 
      node.nodeType === 'ContractDefinition' && 
      node.name === this.contract.contractName
    )
  }

  getLinearizedBaseContracts() {
    return _.reverse(this.getContractNode().linearizedBaseContracts.map(id => this.nodes[id]))
  }

  getStorageInfo(varNode, typeInfo) {
    return {
      label: varNode.name,
      astId: varNode.id,
      type: typeInfo.id
    }
  }

  getTypeInfo(node) {
    // TODO: Handle FunctionTypeName
    switch (node.nodeType) {
      case 'ElementaryTypeName': return this.getElementaryTypeInfo(node);
      case 'ArrayTypeName': return this.getArrayTypeInfo(node);
      case 'Mapping': return this.getMappingTypeInfo(node);
      case 'UserDefinedTypeName': return this.getUserDefinedTypeInfo(node);
      default: throw Error(`Cannot get type info for unknown node type ${node.nodeType}`);
    }
  }

  getUserDefinedTypeInfo({ referencedDeclaration, typeDescriptions }) {
    const referencedNode = this.nodes[referencedDeclaration];
    if (!referencedNode) {
      throw Error(`Could not find referenced AST node ${referencedDeclaration} for type ${typeDescriptions.typeString}`)
    } 

    switch (referencedNode.nodeType) {
      case 'ContractDefinition': return this.getContractTypeInfo(referencedNode)
      case 'StructDefinition': return this.getStructTypeInfo(referencedNode)
      case 'EnumDefinition': return this.getEnumTypeInfo(referencedNode)
      default: return { id: typeDescriptions.typeIdentifier, label: typeDescriptions.typeString }
    }
  }

  getElementaryTypeInfo({ typeDescriptions }) {
    const id = typeDescriptions.typeIdentifier.startsWith('t_string')
      ? 't_string' 
      : typeDescriptions.typeIdentifier;

    return { 
      id,
      kind: 'elementary',
      label: typeDescriptions.typeString
    }
  }
  
  getArrayTypeInfo({ baseType, length, }) {
    const { id: baseTypeId, label: baseTypeLabel } = this.getTypeInfo(baseType)
    const lengthDescriptor = length ? length.value : 'dyn'
    const lengthLabel = length ? length.value : ''
    return { 
      id: `t_array:${lengthDescriptor}<${baseTypeId}>`,
      valueType: baseTypeId,
      length: lengthDescriptor,
      kind: 'array',
      label: `${baseTypeLabel}[${lengthLabel}]`
    }
  }

  getMappingTypeInfo({ valueType }) {
    // We ignore the keyTypeId, since it's always hashed and takes up the same amount of space; we only care about the last value type
    const { id: valueTypeId, label: valueTypeLabel } = this.getValueTypeInfo(valueType)
    return {
      id: `t_mapping<${valueTypeId}>`, 
      valueType: valueTypeId,
      label: `mapping(key => ${valueTypeLabel})`,
      kind: 'mapping'
    }
  }

  getContractTypeInfo() {
    // Process a reference to a contract as an address, since we only care about storage size
    return { 
      id: 't_address', 
      kind: 'elementary',
      label: 'address' 
    } 
  }

  getStructTypeInfo(referencedNode) {
    // Identify structs by contract and name
    const contractName = this.nodes[referencedNode.scope].name
    const id = `t_struct<${contractName}.${referencedNode.name}>`
    if (this.types[id]) return this.types[id]

    // Store members info in type description
    const members = referencedNode.members
      .filter(member => member.nodeType === 'VariableDeclaration')
      .map(member => {
        const typeInfo = this.getTypeInfo(member.typeName)
        this.registerType(typeInfo)
        return this.getStorageInfo(member, typeInfo)
      })

    return {
      id,
      members,
      kind: 'struct',
      label: referencedNode.canonicalName
    }
  }

  getEnumTypeInfo(referencedNode) {
    // Store canonical name and members for an enum
    // Note that enum definition nodes do not have a `scope` property we can use to retrieve the contract node
    return {
      id: `t_enum<${referencedNode.canonicalName}>`,
      kind: 'enum',
      label: referencedNode.canonicalName,
      members: referencedNode.members.map(m => m.name)
    }
  }

  getValueTypeInfo(node) {
    return (node.nodeType === 'Mapping')
      ? this.getValueTypeInfo(node.valueType)
      : this.getTypeInfo(node)
  }  
}
