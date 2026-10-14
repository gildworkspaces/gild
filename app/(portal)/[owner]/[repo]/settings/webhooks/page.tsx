import Page from '../[section]/page'
export default async function Webhooks({params}:{params:Promise<{owner:string;repo:string}>}){return Page({params:Promise.resolve({...await params,section:'webhooks'})})}
